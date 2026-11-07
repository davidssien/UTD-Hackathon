/**
 * MockEgressClient: an in-memory, single-user implementation of EgressClient
 * so the UI can be built before the backend is live. Edits use the real
 * `applyEdit`; runs use a deliberately simple canned walker (straight lines to
 * the nearest exit with a door-capacity queue) until @egress/sim lands in Pass 2.
 */
import {
  ACTOR_EXITED, ACTOR_MOVING, ACTOR_QUEUED, applyEdit, createRng, emptyDocument, FRAMES_PER_CHUNK, TICK_RATE_HZ,
  type ActorFrame, type EditCommand, type EgressDocument, type ID, type Pace, type SimulationMetrics, type SimulationScenario, type Vec2,
} from '@egress/core';
import { ghostFor } from './ghost.ts';
import { Playback } from './playback.ts';
import { writable } from './store.ts';
import type {
  AgentJob, AgentStep, ConnectionStatus, DocumentView, EditResult, EgressClient, Me, ProjectSummary, ProposalView, RunSummary,
} from './types.ts';

type PatchCommand = Extract<EditCommand, { kind: 'applyPatch' }>;

interface MockProject {
  summary: ProjectSummary;
  doc: EgressDocument;
  undo: PatchCommand[];
  redo: PatchCommand[];
}

export interface MockClientOptions {
  /** Projects to start with, e.g. the scene fixtures. */
  seed?: { name: string; doc: EgressDocument }[];
  /** Artificial latency for async calls, ms. */
  latencyMs?: number;
}

const uuid = () => globalThis.crypto.randomUUID();

export function createMockClient(options: MockClientOptions = {}): EgressClient {
  return new MockEgressClient(options);
}

class MockEgressClient implements EgressClient {
  readonly status = writable<ConnectionStatus>('connected');
  readonly me = writable<Me | null>({ identity: 'mock-identity', displayName: 'Mock user' });
  readonly projects = writable<ProjectSummary[]>([]);
  readonly document = writable<DocumentView>({ projectId: null, doc: null, pending: 0, canUndo: false, canRedo: false, lastError: null });
  readonly runs = writable<RunSummary[]>([]);
  readonly agentJobs = writable<AgentJob[]>([]);
  readonly agentSteps = writable<AgentStep[]>([]);
  readonly proposals = writable<ProposalView[]>([]);

  private readonly store = new Map<ID, MockProject>();
  private readonly playbacks = new Map<ID, Playback>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly latency: number;
  private active: ID | null = null;

  constructor(options: MockClientOptions) {
    this.latency = options.latencyMs ?? 0;
    const seeds = options.seed?.length ? options.seed : [{ name: 'Untitled building', doc: emptyDocument('mock-project') }];
    for (const s of seeds) this.addProject(s.name, s.doc);
    void this.openProject(this.projects.get()[0]?.id ?? null);
  }

  // ── projects ──

  private addProject(name: string, seed: EgressDocument): ID {
    const id = `mock-${uuid().slice(0, 8)}`;
    const doc = { ...seed, projectId: id, revision: 0 };
    this.store.set(id, { summary: { id, name, role: 'owner', revision: 0, updatedAt: Date.now() }, doc, undo: [], redo: [] });
    this.projects.set([...this.store.values()].map(p => p.summary));
    return id;
  }

  async setDisplayName(name: string) {
    await this.wait();
    this.me.update(m => (m ? { ...m, displayName: name } : m));
  }

  async createProject(name: string, seed?: EgressDocument) {
    await this.wait();
    const id = this.addProject(name, seed ?? emptyDocument('new'));
    await this.openProject(id);
    return id;
  }

  async openProject(projectId: ID | null) {
    this.active = projectId;
    this.publishDocument(null);
    this.runs.set([]);
    this.agentJobs.set([]);
    this.agentSteps.set([]);
    this.proposals.set([]);
  }

  async createInvite() {
    await this.wait();
    return `MOCK-${uuid().slice(0, 6).toUpperCase()}`;
  }

  async joinProject(_code: string): Promise<ID> {
    await this.wait();
    if (!this.active) throw new Error('The mock client has no shared projects.');
    return this.active;
  }

  // ── editing ──

  async edit(commands: EditCommand[]): Promise<EditResult> {
    const project = this.current();
    if (!project) return { ok: false, error: { code: 'NOT_FOUND', message: 'Open a project first.' } };
    const result = applyEdit(project.doc, { requestId: uuid(), commands });
    if (!result.ok) {
      this.publishDocument(result.error);
      return { ok: false, error: result.error };
    }
    project.undo.push(result.inverse);
    project.redo = [];
    this.commit(project, result.doc);
    return { ok: true, createdIds: result.created };
  }

  async undo() {
    return this.history('undo');
  }

  async redo() {
    return this.history('redo');
  }

  private history(direction: 'undo' | 'redo'): EditResult | null {
    const project = this.current();
    const patch = project?.[direction].pop();
    if (!project || !patch) return null;
    const result = applyEdit(project.doc, { requestId: uuid(), commands: [patch] });
    if (!result.ok) {
      this.publishDocument(result.error);
      return { ok: false, error: result.error };
    }
    project[direction === 'undo' ? 'redo' : 'undo'].push(result.inverse);
    this.commit(project, result.doc);
    return { ok: true, createdIds: result.created };
  }

  private commit(project: MockProject, doc: EgressDocument) {
    project.doc = doc;
    project.summary = { ...project.summary, revision: doc.revision, updatedAt: Date.now() };
    this.projects.set([...this.store.values()].map(p => p.summary));
    this.publishDocument(null);
    this.refreshGhosts();
  }

  private publishDocument(lastError: DocumentView['lastError']) {
    const project = this.current();
    this.document.set({
      projectId: this.active,
      doc: project?.doc ?? null,
      pending: 0,
      canUndo: !!project?.undo.length,
      canRedo: !!project?.redo.length,
      lastError,
    });
  }

  // ── runs ──

  async saveScenario(_scenario: SimulationScenario) {
    await this.wait();
  }

  async startRun(scenario: SimulationScenario, pace: Pace): Promise<ID> {
    const project = this.current();
    if (!project) throw new Error('Open a project first.');
    const runId = `run-${uuid().slice(0, 8)}`;
    const summary: RunSummary = {
      id: runId, projectId: project.summary.id, status: 'running', pace, seed: scenario.population.seed, scenarioName: scenario.name,
      population: scenario.population.count, layoutRevision: project.doc.revision, progressTick: 0, agentJobId: null, createdAt: Date.now(), error: null,
    };
    this.runs.update(list => [summary, ...list]);
    const { frames, metrics } = cannedRun(project.doc, scenario, runId);
    const playback = this.playback(runId);
    playback.setStatus('running');

    const chunkMs = pace === 'unpaced' ? 0 : 2000 / Number(pace.slice(1));
    let next = 0;
    const emit = () => {
      const chunk = frames.slice(next, next + FRAMES_PER_CHUNK);
      next += chunk.length;
      playback.pushFrames(chunk);
      const done = next >= frames.length;
      this.runs.update(list => list.map(r => (r.id === runId ? { ...r, progressTick: next - 1, status: done ? 'complete' : 'running' } : r)));
      if (done) {
        playback.setMetrics(metrics);
        playback.setStatus('complete');
      } else if (chunkMs === 0) {
        emit(); // unpaced: deliver everything now (timers are ~16 ms on Windows)
      } else {
        this.later(emit, chunkMs);
      }
    };
    this.later(emit, chunkMs);
    return runId;
  }

  async cancelRun(runId: ID) {
    this.runs.update(list => list.map(r => (r.id === runId ? { ...r, status: 'cancelled' } : r)));
    this.playbacks.get(runId)?.setStatus('cancelled');
  }

  playback(runId: ID): Playback {
    let p = this.playbacks.get(runId);
    if (!p) {
      p = new Playback(runId);
      this.playbacks.set(runId, p);
    }
    return p;
  }

  // ── agent (canned, but its proposal is a real, valid edit) ──

  async askAgent(prompt: string): Promise<ID> {
    const project = this.current();
    if (!project) throw new Error('Open a project first.');
    const jobId = `job-${uuid().slice(0, 8)}`;
    this.agentJobs.update(list => [{ id: jobId, status: 'running', prompt, summary: '', createdAt: Date.now() }, ...list]);
    const exit = project.doc.openings.find(o => o.openingKind === 'exit');
    const steps: Omit<AgentStep, 'id' | 'jobId' | 'seq' | 'at'>[] = [
      { kind: 'tool_call', toolName: 'inspect_layout', payload: {} },
      { kind: 'tool_result', toolName: 'inspect_layout', payload: { walls: project.doc.walls.length, exits: project.doc.openings.filter(o => o.openingKind === 'exit').length } },
      { kind: 'message', toolName: '', payload: { text: exit ? `(mock) The ${exit.widthM.toFixed(1)} m exit is the likely bottleneck; widening it should raise throughput.` : '(mock) There is no exit yet — add one in Edit mode.' } },
    ];
    steps.forEach((s, i) => this.later(() => {
      this.agentSteps.update(list => [...list, { ...s, id: `${jobId}.${i}`, jobId, seq: i, at: Date.now() }]);
    }, 300 * (i + 1)));

    this.later(() => {
      if (exit) {
        const proposalId = `prop-${uuid().slice(0, 8)}`;
        const commands: EditCommand[] = [{ kind: 'updateOpening', openingId: exit.id, patch: { widthM: exit.widthM + 0.6 } }];
        this.proposals.update(list => [...list, {
          id: proposalId, jobId, status: 'proposed', baseRevision: project.doc.revision, commands,
          notes: { summary: '(mock) Widen the main exit by 0.6 m.', byCommand: { '0': 'Queue forms here; a wider exit increases flow capacity (mock evidence).' } },
          baselineRunId: '', candidateRunId: '', delta: { evacuationTimeSeconds: -12 }, ghost: ghostFor(project.doc, proposalId, commands),
        }]);
      }
      this.agentJobs.update(list => list.map(j => (j.id === jobId ? { ...j, status: 'complete', summary: '(mock) Done.' } : j)));
    }, 300 * (steps.length + 1));
    return jobId;
  }

  async acceptProposal(proposalId: ID) {
    const project = this.current();
    const proposal = this.proposals.get().find(p => p.id === proposalId);
    if (!project || !proposal || proposal.status !== 'proposed') return;
    const result = applyEdit(project.doc, { requestId: proposalId, commands: proposal.commands });
    if (!result.ok) {
      this.setProposalStatus(proposalId, 'stale');
      return;
    }
    project.undo.push(result.inverse);
    project.redo = [];
    this.setProposalStatus(proposalId, 'accepted');
    this.commit(project, result.doc);
  }

  async rejectProposal(proposalId: ID) {
    this.setProposalStatus(proposalId, 'rejected');
  }

  private setProposalStatus(id: ID, status: ProposalView['status']) {
    this.proposals.update(list => list.map(p => (p.id === id ? { ...p, status } : p)));
  }

  private refreshGhosts() {
    const doc = this.current()?.doc ?? null;
    this.proposals.update(list => list.map(p => (p.status === 'proposed' ? { ...p, ghost: ghostFor(doc, p.id, p.commands) } : p)));
  }

  dispose() {
    for (const t of this.timers) clearTimeout(t);
    for (const p of this.playbacks.values()) p.dispose();
  }

  // ── helpers ──

  private current(): MockProject | undefined {
    return this.active ? this.store.get(this.active) : undefined;
  }

  private later(fn: () => void, ms: number) {
    const handle = setTimeout(() => {
      this.timers.delete(handle);
      fn();
    }, ms);
    this.timers.add(handle);
  }

  private wait() {
    return new Promise<void>(resolve => (this.latency ? this.later(resolve, this.latency) : resolve()));
  }
}

/**
 * Canned walker for the mock: spawn inside the vertex bounding box, walk
 * straight to the nearest exit, queue at ~1.3 persons/m/s. Not physics —
 * it ignores walls. Replaced by @egress/sim in Pass 2.
 */
export function cannedRun(doc: EgressDocument, scenario: SimulationScenario, runId: ID): { frames: ActorFrame[]; metrics: SimulationMetrics } {
  const rng = createRng(scenario.population.seed);
  const vertexById = new Map(doc.vertices.map(v => [v.id, v.position]));
  const exits = doc.openings.filter(o => o.openingKind === 'exit').map(o => {
    const wall = doc.walls.find(w => w.id === o.wallId)!;
    const a = vertexById.get(wall.startVertexId)!, b = vertexById.get(wall.endVertexId)!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    return { id: o.id, at: { x: a.x + ((b.x - a.x) * o.offsetM) / len, y: a.y + ((b.y - a.y) * o.offsetM) / len }, perTick: (1.3 * o.widthM) / TICK_RATE_HZ, tokens: 0, through: 0 };
  });
  const xs = doc.vertices.map(v => v.position.x), ys = doc.vertices.map(v => v.position.y);
  const box = xs.length ? { x0: Math.min(...xs) + 0.5, x1: Math.max(...xs) - 0.5, y0: Math.min(...ys) + 0.5, y1: Math.max(...ys) - 0.5 } : { x0: 0, x1: 10, y0: 0, y1: 8 };
  const n = scenario.population.count;
  const pos: Vec2[] = Array.from({ length: n }, () => ({ x: rng.range(box.x0, box.x1), y: rng.range(box.y0, box.y1) }));
  const speed = Array.from({ length: n }, () => Math.min(1.8, Math.max(0.8, rng.normal(1.34, 0.26))));
  const target = pos.map(p => (exits.length ? exits.reduce((best, e) => (Math.hypot(e.at.x - p.x, e.at.y - p.y) < Math.hypot(best.at.x - p.x, best.at.y - p.y) ? e : best)) : null));
  const flags = new Uint8Array(n);
  const frames: ActorFrame[] = [];
  const maxTicks = Math.round(scenario.durationSeconds * TICK_RATE_HZ);
  let maxQueue = 0, lastExitTick = 0;
  for (let tick = 0; tick <= maxTicks; tick++) {
    const xy = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { xy[i * 2] = pos[i].x; xy[i * 2 + 1] = pos[i].y; }
    frames.push({ tick, actorXY: xy, actorFlags: flags.slice() });
    if (!exits.length || flags.every(f => f === ACTOR_EXITED)) break;
    for (const e of exits) e.tokens = Math.min(1, e.tokens + e.perTick);
    let queued = 0;
    for (let i = 0; i < n; i++) {
      const e = target[i];
      if (!e || flags[i] === ACTOR_EXITED) continue;
      const dx = e.at.x - pos[i].x, dy = e.at.y - pos[i].y, d = Math.hypot(dx, dy);
      if (d < 0.6) {
        if (e.tokens >= 1) { e.tokens -= 1; e.through++; flags[i] = ACTOR_EXITED; lastExitTick = tick; }
        else { flags[i] = ACTOR_QUEUED; queued++; }
        continue;
      }
      const step = Math.min(d - 0.5, speed[i] / TICK_RATE_HZ);
      pos[i] = { x: pos[i].x + (dx / d) * step, y: pos[i].y + (dy / d) * step };
      flags[i] = ACTOR_MOVING;
    }
    maxQueue = Math.max(maxQueue, queued);
  }
  const evacuated = flags.filter(f => f === ACTOR_EXITED).length;
  const last = frames[frames.length - 1];
  return {
    frames,
    metrics: {
      runId, tick: last.tick, simulatedSeconds: last.tick / TICK_RATE_HZ, initialPeople: n, evacuatedPeople: evacuated,
      remainingPeople: n - evacuated, unreachablePeople: exits.length ? 0 : n,
      evacuationTimeSeconds: evacuated === n ? lastExitTick / TICK_RATE_HZ : null, maxQueueLength: maxQueue,
      meanCongestion: 0, peakCongestion: 0, perExitThroughput: Object.fromEntries(exits.map(e => [e.id, e.through])), bottlenecks: [], complete: true,
    },
  };
}
