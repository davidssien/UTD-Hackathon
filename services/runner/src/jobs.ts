/**
 * Runner job processing (Plan.md §7), written against a small RunnerBackend
 * interface so it is testable without SpacetimeDB. `main.ts` adapts the
 * generated bindings (reducers + runner views) to this interface.
 */
import {
  canonicalJson, DomainError, encodeChunk, encodeFieldBundle, FIELDS_ENCODING, FRAME_ENCODING, parseDocumentJson, parseScenarioJson,
  TICK_RATE_HZ, type AgentContext, type AgentStepKind, type EditCommand, type EgressDocument, type ID, type Pace, type ProposalNotes,
  type SimulationMetrics,
} from '@egress/core';
import { initialize, simulateChunks, type InitialActors, type SimState } from '@egress/sim';
import {
  runHeuristicAgent, runLlmAgent, ToolBox, type AgentEnvironment, type ChatFn, type ProposalDraft, type RunRecord, type RunRequest,
} from '@egress/agent';

export interface QueuedRun {
  runId: ID;
  layoutHash: string;
  scenarioJson: string;
  pace: Pace;
}

export interface QueuedAgentJob {
  jobId: ID;
  projectId: ID;
  prompt: string;
  contextJson: string;
  snapshotHash: string;
}

/** Everything the runner needs from the database. All writes go through service-only reducers. */
export interface RunnerBackend {
  claimRun(runId: ID): Promise<void>;
  loadSnapshot(layoutHash: string): Promise<EgressDocument>;
  appendChunk(runId: ID, chunkIndex: number, firstTick: number, lastTick: number, encoding: string, bytes: Uint8Array): Promise<void>;
  publishResult(runId: ID, metricsJson: string, fields: Uint8Array, gridJson: string): Promise<void>;
  failRun(runId: ID, code: string, message: string): Promise<void>;
  isCancelled(runId: ID): boolean;

  claimAgentJob(jobId: ID): Promise<void>;
  startAgentRun(runId: ID, jobId: ID, documentJson: string, scenarioJson: string): Promise<void>;
  appendAgentStep(jobId: ID, seq: number, kind: AgentStepKind, toolName: string, payloadJson: string): Promise<void>;
  publishProposal(proposalId: ID, jobId: ID, commands: EditCommand[], notes: ProposalNotes, baselineRunId: ID, candidateRunId: ID, delta: Record<string, number>): Promise<void>;
  finishAgentJob(jobId: ID, status: 'complete' | 'failed', summary: string): Promise<void>;
  /** A finished run's record (metrics + initial actors) for agent baselines, if the runner still has it. */
  findRunRecord(runId: ID): RunRecord | undefined;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = { now: () => Date.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };

const PACE_FACTOR: Record<Pace, number> = { x1: 1, x2: 2, x4: 4, unpaced: 0 };

export interface RunOutcome {
  metrics: SimulationMetrics | null;
  state: SimState | null;
  chunks: number;
  bytes: number;
  computeMs: number;
}

/**
 * Simulate one run end to end: chunks at 2 s of simulated time, paced against
 * the wall clock for user runs (so the LIVE edge grows visibly), unpaced for
 * agent runs. Failures are reported with failRun, never thrown.
 */
export async function processRun(
  backend: RunnerBackend,
  run: QueuedRun,
  options: { clock?: Clock; log?: (line: string) => void; claim?: boolean; streamChunks?: boolean; initialActors?: InitialActors; document?: EgressDocument } = {},
): Promise<RunOutcome> {
  const clock = options.clock ?? systemClock;
  const log = options.log ?? (() => {});
  const outcome: RunOutcome = { metrics: null, state: null, chunks: 0, bytes: 0, computeMs: 0 };
  try {
    if (options.claim !== false) await backend.claimRun(run.runId);
    const document = options.document ?? (await backend.loadSnapshot(run.layoutHash));
    const scenario = parseScenarioJson(run.scenarioJson);
    const state = initialize({ runId: run.runId, document, scenario, initialActors: options.initialActors });
    outcome.state = state;
    const origin = state.compiled.grid.origin;
    const factor = PACE_FACTOR[run.pace];
    const started = clock.now();
    for (const chunk of simulateChunks(state)) {
      const t0 = clock.now();
      if (options.streamChunks !== false) {
        const bytes = encodeChunk(chunk, origin);
        await backend.appendChunk(run.runId, outcome.chunks, chunk.firstTick, chunk.frames[chunk.frames.length - 1].tick, FRAME_ENCODING, bytes);
        outcome.bytes += bytes.length;
      }
      outcome.chunks++;
      outcome.computeMs += clock.now() - t0;
      outcome.metrics = chunk.metrics;
      if (backend.isCancelled(run.runId)) {
        log(`[run ${run.runId}] cancelled at tick ${state.tick}`);
        return outcome;
      }
      if (factor > 0 && !chunk.last) {
        const due = started + ((chunk.frames[chunk.frames.length - 1].tick + 1) / TICK_RATE_HZ / factor) * 1000;
        const wait = due - clock.now();
        // Sleep in short slices so Stop/restart cancels within ~100 ms, even while pacing ahead.
        for (let left = wait; left > 0; left -= 100) {
          await clock.sleep(Math.min(100, left));
          if (backend.isCancelled(run.runId)) {
            log(`[run ${run.runId}] cancelled at tick ${state.tick}`);
            return outcome;
          }
        }
      }
    }
    const fields = state.fields;
    const bundle = encodeFieldBundle({
      grid: state.compiled.grid,
      fields: {
        'people.congestion/timeAverage': fields.field('people.congestion', 'timeAverage')!.values,
        'people.congestion/perCellPeak': fields.field('people.congestion', 'perCellPeak')!.values,
        'people.density/timeAverage': fields.field('people.density', 'timeAverage')!.values,
        'people.density/perCellPeak': fields.field('people.density', 'perCellPeak')!.values,
      },
    });
    await backend.publishResult(run.runId, canonicalJson(outcome.metrics), bundle, canonicalJson({ ...state.compiled.grid, encoding: FIELDS_ENCODING }));
    log(`[run ${run.runId}] ${state.n} people, ${outcome.chunks} chunks, ${(outcome.bytes / 1024).toFixed(0)} KB, ` +
      `${(outcome.computeMs / Math.max(1, state.tick)).toFixed(2)} ms/tick, evacuated ${outcome.metrics?.evacuatedPeople}/${state.n}`);
    return outcome;
  } catch (e) {
    const err = e instanceof DomainError ? e : new DomainError('INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
    log(`[run ${run.runId}] failed: ${err.code} ${err.message}`);
    await backend.failRun(run.runId, err.code, err.message).catch(() => {});
    return outcome;
  }
}

/** AgentEnvironment backed by the database: agent runs become real sim_runs rows with results. */
export class BackendAgentEnvironment implements AgentEnvironment {
  private readonly backend: RunnerBackend;
  private readonly job: QueuedAgentJob;
  private readonly doc: EgressDocument;
  private readonly scenario: ReturnType<typeof parseScenarioJson>;
  private readonly records = new Map<ID, RunRecord>();
  private seq = 0;
  private runs = 0;
  private proposals = 0;

  constructor(backend: RunnerBackend, job: QueuedAgentJob, doc: EgressDocument, scenario: ReturnType<typeof parseScenarioJson>) {
    this.backend = backend;
    this.job = job;
    this.doc = doc;
    this.scenario = scenario;
  }

  document() {
    return this.doc;
  }

  defaultScenario() {
    return this.scenario;
  }

  async runScenario(request: RunRequest): Promise<RunRecord> {
    const runId = `${this.job.jobId}.run${this.runs++}`;
    const documentJson = canonicalJson(request.document);
    const scenarioJson = canonicalJson({ ...request.scenario, projectId: this.job.projectId });
    await this.backend.startAgentRun(runId, this.job.jobId, documentJson, scenarioJson);
    // The snapshot the module froze is exactly this document; feed it straight in.
    const outcome = await processRun(this.backend, { runId, layoutHash: '', scenarioJson, pace: 'unpaced' }, {
      claim: false, streamChunks: true, initialActors: request.initialActors, document: request.document,
    });
    if (!outcome.metrics || !outcome.state) throw new DomainError('INTERNAL_ERROR', `Agent run ${runId} failed.`);
    const record: RunRecord = {
      runId, label: request.label, scenario: request.scenario, layoutHash: outcome.state.compiled.layoutHash, metrics: outcome.metrics,
      initialActors: outcome.state.initial, respawned: outcome.state.respawned, computeMs: outcome.computeMs,
    };
    this.records.set(runId, record);
    return record;
  }

  async getRun(runId: ID) {
    return this.records.get(runId) ?? this.backend.findRunRecord(runId);
  }

  async submitProposal(draft: ProposalDraft): Promise<ID> {
    const id = `${this.job.jobId}.proposal${this.proposals++}`;
    await this.backend.publishProposal(id, this.job.jobId, draft.commands, draft.notes, draft.baselineRunId, draft.candidateRunId, draft.delta);
    return id;
  }

  async log(step: { kind: AgentStepKind; toolName: string; payload: unknown }) {
    await this.backend.appendAgentStep(this.job.jobId, this.seq++, step.kind, step.toolName, JSON.stringify(step.payload).slice(0, 20_000));
  }
}

export async function processAgentJob(
  backend: RunnerBackend,
  job: QueuedAgentJob,
  options: { chat?: ChatFn; defaultPeople?: number; log?: (line: string) => void } = {},
): Promise<void> {
  const log = options.log ?? (() => {});
  try {
    await backend.claimAgentJob(job.jobId);
    const doc = await backend.loadSnapshot(job.snapshotHash);
    const context = safeJson<AgentContext>(job.contextJson) ?? {};
    const baseline = context.runId ? backend.findRunRecord(context.runId) : undefined;
    const scenario = baseline?.scenario ?? parseScenarioJson(canonicalJson({
      scenarioVersion: 1, id: `${job.jobId}.scenario`, projectId: job.projectId, name: 'Evacuate', durationSeconds: 400,
      population: { count: options.defaultPeople ?? 150, distribution: 'uniform', strokes: [], seed: 1 }, goal: { kind: 'evacuate', blockedExitIds: [] },
    }));
    const env = new BackendAgentEnvironment(backend, job, doc, scenario);
    const tools = new ToolBox(env, job.jobId);
    const outcome = options.chat ? await runLlmAgent(tools, options.chat, job.prompt, context) : await runHeuristicAgent(tools, context);
    log(`[agent ${job.jobId}] ${outcome.mode}, ${outcome.toolCalls} tool calls, ${outcome.proposalIds.length} proposal(s)`);
    await backend.finishAgentJob(job.jobId, 'complete', outcome.message);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(`[agent ${job.jobId}] failed: ${message}`);
    await backend.finishAgentJob(job.jobId, 'failed', message).catch(() => {});
  }
}

function safeJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Re-export for adapters that need to parse snapshot rows. */
export { parseDocumentJson };
