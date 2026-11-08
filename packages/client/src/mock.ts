/**
 * MockEgressClient: an in-memory, single-user implementation of EgressClient
 * so the UI can be built before the backend is live. Edits use the real
 * `applyEdit`; runs execute the real @egress/sim model in the browser, paced like
 * the runner (one 2 s chunk every 2 s ÷ pace) so the LIVE edge behaves the same.
 */
import {
  applyEdit, DomainError, emptyDocument,
  type EditCommand, type EgressDocument, type ID, type Pace, type SimulationScenario,
} from '@egress/core';
import { initialize, simulateChunks, type RunChunk } from '@egress/sim';
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
  private readonly cancelled = new Set<ID>();

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
    const playback = this.playback(runId);
    playback.setLayout(project.doc);
    const update = (patch: Partial<RunSummary>) => this.runs.update(list => list.map(r => (r.id === runId ? { ...r, ...patch } : r)));

    // The real model, in the browser (client-cpu). The runner uses the same code server-side.
    let chunks: Generator<RunChunk>;
    try {
      chunks = simulateChunks(initialize({ runId, document: project.doc, scenario }));
    } catch (e) {
      const error = e instanceof DomainError ? e.toJSON() : { code: 'INTERNAL_ERROR' as const, message: String(e) };
      update({ status: 'failed', error });
      playback.setStatus('failed');
      return runId;
    }
    playback.setStatus('running');
    this.cancelled.delete(runId);
    const chunkMs = pace === 'unpaced' ? 0 : 2000 / Number(pace.slice(1));
    const emit = () => {
      if (this.cancelled.has(runId)) return;
      const { value: chunk, done } = chunks.next();
      if (done || !chunk) return;
      playback.pushFrames(chunk.frames);
      playback.setMetrics(chunk.metrics);
      update({ progressTick: chunk.frames[chunk.frames.length - 1].tick, status: chunk.last ? 'complete' : 'running' });
      if (chunk.last) playback.setStatus('complete');
      else this.later(emit, chunkMs);
    };
    this.later(emit, chunkMs);
    return runId;
  }

  async cancelRun(runId: ID) {
    this.cancelled.add(runId);
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
