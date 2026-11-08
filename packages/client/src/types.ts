/**
 * The EgressClient contract (Plan.md §8). The UI talks to the backend only
 * through this interface; `createMockClient` and `createSpacetimeClient`
 * implement it identically.
 */
import type {
  ActorFrame, AgentContext, AgentStepKind, Aggregation, DomainErrorData, EditCommand, EgressDocument, FieldId, ID, Pace,
  ProposalNotes, ProposalStatus, Role, RunStatus, ScalarField, SimulationMetrics, SimulationScenario,
} from '@egress/core';

/** Minimal observable value; plugs straight into React's useSyncExternalStore (see `useEgress`). */
export interface Store<T> {
  get(): T;
  subscribe(listener: () => void): () => void;
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

/** Whether a simulation/agent runner is alive. Show "simulation server offline" when `online` is false. */
export interface RunnerStatus {
  online: boolean;
  lastSeenMs: number | null;
  agentModel: string | null;
  activeRuns: number;
  activeJobs: number;
}

export interface Me {
  identity: string;
  displayName: string;
}

export interface ProjectSummary {
  id: ID;
  name: string;
  role: Role;
  revision: number;
  updatedAt: number; // ms since epoch
}

export interface DocumentView {
  projectId: ID | null;
  /** Server state plus any optimistic edits still waiting for confirmation. */
  doc: EgressDocument | null;
  /** Number of local edits not yet confirmed by the server. */
  pending: number;
  canUndo: boolean;
  canRedo: boolean;
  /** Last rejected edit, cleared on the next successful one. */
  lastError: DomainErrorData | null;
}

export type EditResult = { ok: true; createdIds: ID[][] } | { ok: false; error: DomainErrorData };

export interface RunSummary {
  id: ID;
  projectId: ID;
  status: RunStatus;
  pace: Pace;
  seed: number;
  scenarioName: string;
  population: number;
  layoutRevision: number;
  /** Latest simulated tick available to play (the LIVE edge). */
  progressTick: number;
  agentJobId: ID | null;
  createdAt: number;
  error: DomainErrorData | null;
}

export interface PlaybackState {
  runId: ID;
  status: RunStatus;
  /** Current playback tick (fractional while interpolating). */
  tick: number;
  /** Latest tick received from the server — the LIVE edge of the scrubber. */
  liveTick: number;
  /** True while the playhead sits at the LIVE edge of a running simulation. */
  atLiveEdge: boolean;
  playing: boolean;
  /** True once the run finished and every chunk is loaded (badge shows END). */
  complete: boolean;
  /** Playback speed multiplier for client-side playback. */
  speed: number;
  actorCount: number;
}

export interface PlaybackController {
  readonly state: Store<PlaybackState>;
  readonly metrics: Store<SimulationMetrics | null>;
  play(): void;
  pause(): void;
  toggle(): void;
  /** Jump to an absolute tick, clamped to [0, liveTick]. */
  seek(tick: number): void;
  /** Relative jump in simulated seconds (the « 10 / » 10 buttons). */
  skip(seconds: number): void;
  goLive(): void;
  setSpeed(speed: number): void;
  /** Interpolated actor positions at the current playhead. */
  actorsNow(): ActorFrame | null;
  /** Heatmap for the current playhead (instant) or accumulated up to it. Pass 2. */
  field(id: FieldId, aggregation: Aggregation): ScalarField | null;
  dispose(): void;
}

/** Before/after comparison of two finished runs (Analysis mode). Deltas are candidate − baseline. */
export interface RunComparison {
  baselineRunId: ID;
  candidateRunId: ID;
  baseline: SimulationMetrics;
  candidate: SimulationMetrics;
  delta: Record<string, number>;
  /** Candidate − baseline time-averaged congestion on the baseline grid; negative cells = crowding relieved. */
  congestionDiff: ScalarField | null;
}

export interface AgentStep {
  id: string;
  jobId: ID;
  seq: number;
  kind: AgentStepKind;
  toolName: string;
  payload: unknown;
  at: number;
}

export interface AgentJob {
  id: ID;
  status: 'queued' | 'running' | 'complete' | 'failed';
  prompt: string;
  summary: string;
  createdAt: number;
}

export interface ProposalView {
  id: ID;
  jobId: ID;
  status: ProposalStatus;
  baseRevision: number;
  commands: EditCommand[];
  notes: ProposalNotes;
  baselineRunId: ID;
  candidateRunId: ID;
  delta: Record<string, number>;
  /**
   * Ghost preview: the proposal applied to the current document with
   * requestId = proposal id (same ids Accept will create). null when stale.
   */
  ghost: { doc: EgressDocument; createdIds: ID[][]; changedIds: ID[]; removedIds: ID[] } | null;
}

export interface EgressClient {
  readonly status: Store<ConnectionStatus>;
  readonly runner: Store<RunnerStatus>;
  readonly me: Store<Me | null>;
  readonly projects: Store<ProjectSummary[]>;
  readonly document: Store<DocumentView>;
  readonly runs: Store<RunSummary[]>;
  readonly agentJobs: Store<AgentJob[]>;
  readonly agentSteps: Store<AgentStep[]>;
  readonly proposals: Store<ProposalView[]>;

  setDisplayName(name: string): Promise<void>;
  createProject(name: string, seed?: EgressDocument): Promise<ID>;
  openProject(projectId: ID | null): Promise<void>;
  /** Returns the plain invite code to share; only its hash is stored. */
  createInvite(role: Exclude<Role, 'owner'>, ttlHours?: number): Promise<string>;
  joinProject(code: string): Promise<ID>;

  /** Applies optimistically, then confirms with the server. Atomic batch. */
  edit(commands: EditCommand[]): Promise<EditResult>;
  undo(): Promise<EditResult | null>;
  redo(): Promise<EditResult | null>;

  saveScenario(scenario: SimulationScenario): Promise<void>;
  startRun(scenario: SimulationScenario, pace: Pace): Promise<ID>;
  cancelRun(runId: ID): Promise<void>;
  /** One controller per run; dispose it when the view unmounts. */
  playback(runId: ID): PlaybackController;

  askAgent(prompt: string, context?: AgentContext): Promise<ID>;
  /** Resolves once both runs have stored results. */
  compareRuns(baselineRunId: ID, candidateRunId: ID): Promise<RunComparison>;
  acceptProposal(proposalId: ID): Promise<void>;
  rejectProposal(proposalId: ID): Promise<void>;

  dispose(): void;
}
