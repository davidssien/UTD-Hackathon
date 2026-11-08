/**
 * What the agent's tools can touch. The runner implements this over
 * SpacetimeDB (runs become real `sim_runs` rows); the mock client and tests use
 * `LocalEnvironment`, which runs the same simulation in-process.
 */
import type { AgentStepKind, EditCommand, EgressDocument, ID, ProposalNotes, ScalarField, SimulationMetrics, SimulationScenario } from '@egress/core';
import { layoutHash } from '@egress/core';
import { runSimulation, type InitialActors } from '@egress/sim';

export interface RunRecord {
  runId: ID;
  label: string;
  scenario: SimulationScenario;
  layoutHash: string;
  metrics: SimulationMetrics;
  initialActors: InitialActors;
  /** People that had to be respawned because the candidate layout blocked their start spot. */
  respawned: number;
  computeMs: number;
  /** Time-averaged congestion, kept for before/after difference maps. */
  congestionAverage?: ScalarField;
}

export interface RunRequest {
  document: EgressDocument;
  scenario: SimulationScenario;
  label: string;
  initialActors?: InitialActors;
}

export interface ProposalDraft {
  commands: EditCommand[];
  notes: ProposalNotes;
  baselineRunId: ID;
  candidateRunId: ID;
  delta: Record<string, number>;
}

export interface AgentStepRecord {
  kind: AgentStepKind;
  toolName: string;
  payload: unknown;
}

export interface AgentEnvironment {
  /** The layout the job analyses (frozen when the job was requested). */
  document(): EgressDocument;
  /** Scenario to test when the agent does not specify one. */
  defaultScenario(): SimulationScenario;
  runScenario(request: RunRequest): Promise<RunRecord>;
  getRun(runId: ID): Promise<RunRecord | undefined>;
  submitProposal(draft: ProposalDraft): Promise<ID>;
  log(step: AgentStepRecord): Promise<void>;
}

/** In-process environment: real simulations, in-memory records. */
export class LocalEnvironment implements AgentEnvironment {
  readonly runs = new Map<ID, RunRecord>();
  readonly proposals: (ProposalDraft & { id: ID })[] = [];
  readonly steps: AgentStepRecord[] = [];
  private readonly doc: EgressDocument;
  private readonly scenario: SimulationScenario;
  private readonly onStep?: (step: AgentStepRecord) => void;
  private readonly onRun?: (run: RunRecord) => void;
  private counter = 0;
  private readonly prefix: string;

  constructor(options: {
    document: EgressDocument;
    scenario: SimulationScenario;
    jobId: ID;
    existingRuns?: RunRecord[];
    onStep?: (step: AgentStepRecord) => void;
    onRun?: (run: RunRecord) => void;
  }) {
    this.doc = options.document;
    this.scenario = options.scenario;
    this.prefix = options.jobId;
    this.onStep = options.onStep;
    this.onRun = options.onRun;
    for (const r of options.existingRuns ?? []) this.runs.set(r.runId, r);
  }

  document() {
    return this.doc;
  }

  defaultScenario() {
    return this.scenario;
  }

  async runScenario(request: RunRequest): Promise<RunRecord> {
    const runId = `${this.prefix}.run${this.counter++}`;
    await yieldToEventLoop();
    const result = runSimulation({ runId, document: request.document, scenario: request.scenario, initialActors: request.initialActors }, { keepChunks: false });
    const record: RunRecord = {
      runId, label: request.label, scenario: request.scenario, layoutHash: layoutHash(request.document), metrics: result.metrics,
      initialActors: result.state.initial, respawned: result.state.respawned, computeMs: result.computeMs,
      congestionAverage: result.state.fields.field('people.congestion', 'timeAverage') ?? undefined,
    };
    this.runs.set(runId, record);
    this.onRun?.(record);
    return record;
  }

  async getRun(runId: ID) {
    return this.runs.get(runId);
  }

  async submitProposal(draft: ProposalDraft): Promise<ID> {
    const id = `${this.prefix}.proposal${this.proposals.length}`;
    this.proposals.push({ ...draft, id });
    return id;
  }

  async log(step: AgentStepRecord) {
    this.steps.push(step);
    this.onStep?.(step);
    await yieldToEventLoop();
  }
}

/** Lets a browser repaint between tool steps. */
export const yieldToEventLoop = () => new Promise<void>(resolve => setTimeout(resolve, 0));
