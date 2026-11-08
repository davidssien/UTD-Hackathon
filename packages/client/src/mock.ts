/**
 * MockEgressClient: an in-memory, single-user implementation of EgressClient
 * so the UI can be built before the backend is live. Edits use the real
 * `applyEdit`; runs execute the real @egress/sim model in the browser, paced like
 * the runner (one 2 s chunk every 2 s ÷ pace) so the LIVE edge behaves the same.
 */
import {
  applyEdit, DomainError, emptyDocument, layoutHash,
  type AgentContext, type EditCommand, type EgressDocument, type ID, type Pace, type SimulationScenario,
} from '@egress/core';
import { initialize, simulateChunks, type RunChunk, type SimState } from '@egress/sim';
import { LocalEnvironment, runHeuristicAgent, ToolBox, type RunRecord } from '@egress/agent';
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
  private readonly lastScenario = new Map<ID, SimulationScenario>();
  /** Finished user runs, so the agent can use them as baselines (same people via state.initial). */
  private readonly runRecords = new Map<ID, RunRecord & { projectId: ID }>();

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
    this.lastScenario.set(project.summary.id, scenario);
    const playback = this.playback(runId);
    playback.setLayout(project.doc);
    const update = (patch: Partial<RunSummary>) => this.runs.update(list => list.map(r => (r.id === runId ? { ...r, ...patch } : r)));

    // The real model, in the browser (client-cpu). The runner uses the same code server-side.
    let chunks: Generator<RunChunk>;
    let state: SimState;
    try {
      state = initialize({ runId, document: project.doc, scenario });
      chunks = simulateChunks(state);
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
      if (chunk.last) {
        playback.setStatus('complete');
        this.runRecords.set(runId, {
          runId, projectId: project.summary.id, label: scenario.name, scenario, layoutHash: state.compiled.layoutHash,
          metrics: chunk.metrics, initialActors: state.initial, respawned: 0, computeMs: 0,
        });
      }
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

  // ── agent: the real tools + measured heuristic planner, in the browser (no model key here) ──

  async askAgent(prompt: string, context: AgentContext = {}): Promise<ID> {
    const project = this.current();
    if (!project) throw new Error('Open a project first.');
    const projectId = project.summary.id;
    const jobId = `job-${uuid().slice(0, 8)}`;
    this.agentJobs.update(list => [{ id: jobId, status: 'running', prompt, summary: '', createdAt: Date.now() }, ...list]);
    const document = project.doc;
    const scenario = this.lastScenario.get(projectId) ?? {
      scenarioVersion: 1 as const, id: `${jobId}.scenario`, projectId, name: 'Evacuate', durationSeconds: 400,
      population: { count: 150, distribution: 'uniform' as const, strokes: [], seed: 1 }, goal: { kind: 'evacuate' as const, blockedExitIds: [] },
    };
    let seq = 0;
    const env = new LocalEnvironment({
      document, scenario, jobId,
      existingRuns: [...this.runRecords.values()].filter(r => r.projectId === projectId && r.layoutHash === layoutHash(document)),
      onStep: step => this.agentSteps.update(list => [...list, { ...step, id: `${jobId}.${seq}`, jobId, seq: seq++, at: Date.now() }]),
      onRun: run => this.runs.update(list => [{
        id: run.runId, projectId, status: 'complete', pace: 'unpaced', seed: run.scenario.population.seed, scenarioName: run.label,
        population: run.metrics.initialPeople, layoutRevision: document.revision, progressTick: run.metrics.tick, agentJobId: jobId, createdAt: Date.now(), error: null,
      }, ...list]),
    });
    void (async () => {
      try {
        const outcome = await runHeuristicAgent(new ToolBox(env, jobId), context);
        const current = this.current()?.doc ?? document;
        this.proposals.update(list => [...list, ...env.proposals.map(p => ({
          id: p.id, jobId, status: 'proposed' as const, baseRevision: document.revision, commands: p.commands, notes: p.notes,
          baselineRunId: p.baselineRunId, candidateRunId: p.candidateRunId, delta: p.delta, ghost: ghostFor(current, p.id, p.commands),
        }))]);
        this.agentJobs.update(list => list.map(j => (j.id === jobId ? { ...j, status: 'complete', summary: outcome.message } : j)));
      } catch (e) {
        this.agentSteps.update(list => [...list, { id: `${jobId}.${seq}`, jobId, seq: seq++, kind: 'error', toolName: '', payload: { message: String(e) }, at: Date.now() }]);
        this.agentJobs.update(list => list.map(j => (j.id === jobId ? { ...j, status: 'failed', summary: String(e) } : j)));
      }
    })();
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
