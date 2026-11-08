/**
 * SpacetimeEgressClient: the real EgressClient over the generated bindings.
 * Same interface as the mock (docs/ARCHITECTURE.md §8), so the UI switches with one line:
 *
 *   const client = createSpacetimeClient({ uri: 'ws://127.0.0.1:3010', db: 'egress-dev' });
 *
 * Reads come only from the caller-scoped views; writes only through reducers.
 * Edits are optimistic (OptimisticDocument), replay chunks feed Playback.
 */
import {
  ACTOR_EXITED, canonicalJson, decodeChunk, decodeFieldBundle, DomainError, entitiesToDocument, fieldDifference, metricsDelta, parseDocumentJson,
  sha256Hex, TICK_RATE_HZ, type ScalarField,
  type AgentContext, type DomainErrorData, type EditCommand, type EgressDocument, type Entity, type ID, type Pace, type Role,
  type SimulationMetrics, type SimulationScenario,
} from '@egress/core';
import { DbConnection, tables } from './bindings/index.ts';
import { ghostFor } from './ghost.ts';
import { OptimisticDocument } from './optimistic.ts';
import { Playback } from './playback.ts';
import { writable } from './store.ts';
import type {
  AgentJob, AgentStep, ConnectionStatus, DocumentView, EditResult, EgressClient, Me, ProjectSummary, ProposalView, RunComparison, RunnerStatus, RunSummary,
} from './types.ts';

export interface SpacetimeClientOptions {
  uri: string;
  db: string;
  /** Persisted identity token. Defaults to localStorage in browsers. */
  tokenStore?: { get(): string | undefined; set(token: string): void };
}

export function createSpacetimeClient(options: SpacetimeClientOptions): EgressClient {
  return new SpacetimeEgressClient(options);
}

const uuid = () => globalThis.crypto.randomUUID();
const ms = (t: { toMillis(): bigint }) => Number(t.toMillis());
const parse = <T>(text: string, fallback: T): T => { try { return JSON.parse(text) as T; } catch { return fallback; } };
const wireError = (e: unknown): DomainErrorData => (e instanceof DomainError ? e.toJSON() : DomainError.fromWire(e instanceof Error ? e.message : String(e)).toJSON());

function browserTokenStore(db: string) {
  const key = `egress-token:${db}`;
  return {
    get: () => { try { return globalThis.localStorage?.getItem(key) ?? undefined; } catch { return undefined; } },
    set: (token: string) => { try { globalThis.localStorage?.setItem(key, token); } catch { /* private mode */ } },
  };
}

class SpacetimeEgressClient implements EgressClient {
  readonly status = writable<ConnectionStatus>('connecting');
  readonly connectionError = writable<string | null>(null);
  readonly me = writable<Me | null>(null);
  readonly projects = writable<ProjectSummary[]>([]);
  readonly document = writable<DocumentView>({ projectId: null, doc: null, pending: 0, canUndo: false, canRedo: false, lastError: null });
  readonly runs = writable<RunSummary[]>([]);
  readonly agentJobs = writable<AgentJob[]>([]);
  readonly agentSteps = writable<AgentStep[]>([]);
  readonly proposals = writable<ProposalView[]>([]);
  readonly runner = writable<RunnerStatus>({ online: false, lastSeenMs: null, agentModel: null, activeRuns: 0, activeJobs: 0 });

  private readonly ready: Promise<DbConnection>;
  private readonly runnerTimer: ReturnType<typeof setInterval>;
  private readonly layouts = new Map<string, EgressDocument>();
  private conn: DbConnection | null = null;
  private readonly od = new OptimisticDocument();
  private readonly playbacks = new Map<ID, Playback>();
  private readonly loaded = new Map<ID, Set<number>>();
  private readonly parsedEntities = new Map<string, Entity>();
  private refreshQueued = false;
  private activeProjectId: ID | null = null;
  private activeRunId: ID | null = null;

  constructor(options: SpacetimeClientOptions) {
    const tokens = options.tokenStore ?? browserTokenStore(options.db);
    this.ready = new Promise((resolve, reject) => {
      DbConnection.builder()
        .withUri(options.uri)
        .withDatabaseName(options.db)
        .withToken(tokens.get())
        .onConnect((conn, _identity, token) => {
          tokens.set(token);
          this.conn = conn;
          this.listen(conn);
          conn.subscriptionBuilder()
            .onApplied(() => { this.connectionError.set(null); this.status.set('connected'); this.refresh(); resolve(conn); })
            .onError(ctx => {
              // Usually the database runs an older module that lacks a view this client subscribes to.
              const detail = ctx.event?.message ? ` (${ctx.event.message})` : '';
              const message = `Database "${options.db}" rejected the subscription${detail}. It is probably running an older module than this app; publish the current one with npm run db:publish.`;
              this.connectionError.set(message); this.status.set('error'); reject(new Error(message));
            })
            .subscribe([
              tables.myProfile, tables.mySession, tables.myProjects, tables.myMemberships, tables.activeMembers, tables.activeEntities,
              tables.activeEditLog, tables.activeScenarios, tables.activeRuns, tables.activeReplay, tables.activeResult,
              tables.activeAgentJobs, tables.activeAgentSteps, tables.activeProposals, tables.activeRunLayout, tables.runnerStatus, tables.activeCompareResults,
            ]);
        })
        .onConnectError((_ctx, error) => {
          this.connectionError.set(`Could not connect to ${options.uri} (database "${options.db}"): ${error?.message ?? 'unknown error'}.`);
          this.status.set('error'); reject(error);
        })
        .onDisconnect(() => this.status.set('disconnected'))
        .build();
    });
    // Calls that await `ready` still see the failure; this only stops an unhandled-rejection report.
    this.ready.catch(() => {});
    // Liveness decays with time even when no rows change.
    this.runnerTimer = setInterval(() => this.refreshRunner(), 5000);
  }

  /** A runner counts as online if it sent a heartbeat in the last 20 s (heartbeats every 5 s). */
  private refreshRunner() {
    const conn = this.conn;
    if (!conn) return;
    const beats = [...conn.db.runnerStatus.iter()].sort((a, b) => ms(b.lastSeen) - ms(a.lastSeen));
    const newest = beats[0];
    const online = beats.filter(b => Date.now() - ms(b.lastSeen) < 20_000);
    this.runner.set({
      online: online.length > 0,
      lastSeenMs: newest ? ms(newest.lastSeen) : null,
      agentModel: (online[0] ?? newest)?.agentModel ?? null,
      activeRuns: online.reduce((s, b) => s + b.activeRuns, 0),
      activeJobs: online.reduce((s, b) => s + b.activeJobs, 0),
    });
  }

  // ── wiring ──

  private listen(conn: DbConnection) {
    const schedule = () => this.scheduleRefresh();
    const handles = [
      conn.db.myProfile, conn.db.mySession, conn.db.myProjects, conn.db.myMemberships, conn.db.activeEntities, conn.db.activeEditLog,
      conn.db.activeRuns, conn.db.activeReplay, conn.db.activeResult, conn.db.activeAgentJobs, conn.db.activeAgentSteps, conn.db.activeProposals,
      conn.db.activeRunLayout, conn.db.runnerStatus, conn.db.activeCompareResults,
    ] as { onInsert(cb: () => void): void; onDelete(cb: () => void): void; onUpdate?: (cb: () => void) => void }[];
    // Status changes (runs, jobs, proposals, sessions) arrive as updates on rows with a primary key.
    for (const h of handles) { h.onInsert(schedule); h.onDelete(schedule); h.onUpdate?.(schedule); }
  }

  private scheduleRefresh() {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    queueMicrotask(() => { this.refreshQueued = false; this.refresh(); });
  }

  /** Rebuild every store from the subscribed caches (cheap at hackathon scale). */
  private refresh() {
    const conn = this.conn;
    if (!conn) return;
    this.refreshRunner();
    const profile = [...conn.db.myProfile.iter()][0];
    this.me.set(profile ? { identity: profile.identity.toHexString(), displayName: profile.displayName } : null);
    const session = [...conn.db.mySession.iter()][0];
    this.activeProjectId = session?.activeProjectId || null;
    this.activeRunId = session?.activeRunId || null;

    const roles = new Map([...conn.db.myMemberships.iter()].map(m => [m.projectId, m.role as Role]));
    const projectRows = [...conn.db.myProjects.iter()];
    this.projects.set(projectRows
      .map(p => ({ id: p.id, name: p.name, role: roles.get(p.id) ?? 'viewer', revision: Number(p.revision), updatedAt: ms(p.updatedAt) }))
      .sort((a, b) => b.updatedAt - a.updatedAt));

    // Document: entity rows of the active project, with optimistic edits rebased on top.
    const project = projectRows.find(p => p.id === this.activeProjectId);
    if (project) {
      const rows = [...conn.db.activeEntities.iter()].filter(r => r.projectId === project.id);
      const entities = rows.map(r => {
        const key = `${r.id}@${r.rev}:${r.payload.length}`;
        let e = this.parsedEntities.get(key);
        if (!e) { e = JSON.parse(r.payload) as Entity; this.parsedEntities.set(key, e); }
        return e;
      });
      const doc = entitiesToDocument(project.id, Number(project.revision), entities);
      this.od.setServer(doc, [...conn.db.activeEditLog.iter()].map(l => l.requestId));
    } else {
      this.od.setServer(null);
    }
    this.publishDocument();

    this.runs.set([...conn.db.activeRuns.iter()].map(r => {
      const scenario = parse<Partial<SimulationScenario>>(r.scenario, {});
      return {
        id: r.id, projectId: r.projectId, status: r.status as RunSummary['status'], pace: r.pace as Pace, seed: r.seed,
        scenarioName: scenario.name ?? 'Run', population: scenario.population?.count ?? 0, layoutRevision: Number(r.layoutRevision),
        progressTick: r.progressTick, agentJobId: r.agentJobId || null, createdAt: ms(r.createdAt),
        error: r.errorCode ? { code: r.errorCode as DomainErrorData['code'], message: r.errorMessage } : null,
      };
    }).sort((a, b) => b.createdAt - a.createdAt));

    this.agentJobs.set([...conn.db.activeAgentJobs.iter()].map(j => ({
      id: j.id, status: j.status as AgentJob['status'], prompt: j.prompt, summary: j.summary, createdAt: ms(j.createdAt),
    })).sort((a, b) => b.createdAt - a.createdAt));
    this.agentSteps.set([...conn.db.activeAgentSteps.iter()].map(s => ({
      id: String(s.id), jobId: s.jobId, seq: s.seq, kind: s.kind as AgentStep['kind'], toolName: s.toolName, payload: parse(s.payload, s.payload), at: ms(s.at),
    })).sort((a, b) => (a.jobId === b.jobId ? a.seq - b.seq : a.at - b.at)));
    const view = this.od.view;
    this.proposals.set([...conn.db.activeProposals.iter()].map(p => {
      const commands = parse<EditCommand[]>(p.commands, []);
      return {
        id: p.id, jobId: p.jobId, status: p.status as ProposalView['status'], baseRevision: Number(p.baseRevision), commands,
        notes: parse(p.notes, { summary: '', byCommand: {} }), baselineRunId: p.baselineRunId, candidateRunId: p.candidateRunId,
        delta: parse<Record<string, number>>(p.delta, {}), ghost: p.status === 'proposed' ? ghostFor(view, p.id, commands) : null,
      };
    }));

    this.feedPlayback();
  }

  private publishDocument() {
    this.document.set({
      projectId: this.activeProjectId, doc: this.od.view, pending: this.od.pendingCount,
      canUndo: this.od.canUndo, canRedo: this.od.canRedo, lastError: this.od.lastError,
    });
  }

  /** Push newly arrived replay chunks, status and metrics into the active run's playback. */
  private feedPlayback() {
    const conn = this.conn;
    const runId = this.activeRunId;
    const playback = runId ? this.playbacks.get(runId) : undefined;
    if (!conn || !runId || !playback) return;
    const seen = this.loaded.get(runId) ?? new Set<number>();
    this.loaded.set(runId, seen);
    for (const chunk of [...conn.db.activeReplay.iter()].filter(c => c.runId === runId).sort((a, b) => a.chunkIndex - b.chunkIndex)) {
      if (seen.has(chunk.chunkIndex)) continue;
      seen.add(chunk.chunkIndex);
      playback.pushFrames(decodeChunk(chunk.bytes).frames);
    }
    const run = [...conn.db.activeRuns.iter()].find(r => r.id === runId);
    // Replays and heatmaps use the geometry the run actually saw, not the current edit state.
    const snapshot = run && [...conn.db.activeRunLayout.iter()].find(l => l.hash === run.layoutHash);
    if (snapshot) {
      let layout = this.layouts.get(snapshot.hash);
      if (!layout) { layout = parseDocumentJson(snapshot.document); this.layouts.set(snapshot.hash, layout); }
      playback.setLayout(layout);
    }
    const result = [...conn.db.activeResult.iter()].find(r => r.runId === runId);
    if (result) playback.setMetrics(parse<SimulationMetrics | null>(result.metrics, null));
    else playback.setMetrics(liveMetrics(runId, playback));
    if (run) playback.setStatus(run.status === 'complete' && !result ? 'running' : (run.status as RunSummary['status']));
  }

  private async call<T>(fn: (conn: DbConnection) => Promise<T>): Promise<T> {
    const conn = await this.ready;
    try {
      return await fn(conn);
    } catch (e) {
      throw new DomainError(wireError(e).code, wireError(e).message);
    }
  }

  // ── EgressClient ──

  async setDisplayName(name: string) {
    await this.call(c => c.reducers.setDisplayName({ name }));
  }

  async createProject(name: string, seed?: EgressDocument) {
    const projectId = `p-${uuid()}`;
    await this.call(c => c.reducers.createProject({ projectId, name, seedDocument: seed ? canonicalJson({ ...seed, projectId, revision: 0 }) : '' }));
    return projectId;
  }

  async openProject(projectId: ID | null) {
    await this.call(c => c.reducers.openProject({ projectId: projectId ?? '' }));
  }

  async createInvite(role: Exclude<Role, 'owner'>, ttlHours = 72) {
    if (!this.activeProjectId) throw new DomainError('NOT_FOUND', 'Open a project first.');
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const code = Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
    const projectId = this.activeProjectId;
    await this.call(c => c.reducers.createInvite({ projectId, role, codeHash: sha256Hex(code), ttlHours }));
    return code;
  }

  async joinProject(code: string) {
    await this.call(c => c.reducers.joinProject({ code }));
    this.refresh();
    return this.activeProjectId ?? '';
  }

  async edit(commands: EditCommand[]): Promise<EditResult> {
    return this.send(commands, 'record');
  }

  async undo() {
    const patch = this.od.takeUndo();
    return patch ? this.send([patch], 'undo') : null;
  }

  async redo() {
    const patch = this.od.takeRedo();
    return patch ? this.send([patch], 'redo') : null;
  }

  private async send(commands: EditCommand[], history: 'record' | 'undo' | 'redo'): Promise<EditResult> {
    const projectId = this.activeProjectId;
    const requestId = uuid();
    const local = this.od.propose(requestId, commands, history);
    this.publishDocument();
    if (!local.ok || !projectId) return local.ok ? { ok: false, error: { code: 'NOT_FOUND', message: 'Open a project first.' } } : local;
    try {
      await this.call(c => c.reducers.applyEdit({ request: canonicalJson({ projectId, ...local.request }) }));
      return { ok: true, createdIds: local.created };
    } catch (e) {
      const error = wireError(e);
      this.od.reject(requestId, error);
      this.publishDocument();
      return { ok: false, error };
    }
  }

  async saveScenario(scenario: SimulationScenario) {
    await this.call(c => c.reducers.saveScenario({ scenario: canonicalJson(scenario) }));
  }

  async startRun(scenario: SimulationScenario, pace: Pace) {
    const runId = `run-${uuid()}`;
    const projectId = this.activeProjectId ?? scenario.projectId;
    await this.call(c => c.reducers.requestSimulation({ runId, pace, scenario: canonicalJson({ ...scenario, projectId }) }));
    return runId;
  }

  async cancelRun(runId: ID) {
    await this.call(c => c.reducers.cancelSimulation({ runId }));
  }

  playback(runId: ID): Playback {
    let p = this.playbacks.get(runId);
    if (!p) {
      p = new Playback(runId);
      if (this.od.view) p.setLayout(this.od.view);
      this.playbacks.set(runId, p);
      if (this.activeRunId !== runId) void this.call(c => c.reducers.openRun({ runId })).catch(() => {});
      this.scheduleRefresh();
    }
    return p;
  }

  async askAgent(prompt: string, context: AgentContext = {}) {
    if (!this.activeProjectId) throw new DomainError('NOT_FOUND', 'Open a project first.');
    const jobId = `job-${uuid()}`;
    const projectId = this.activeProjectId;
    await this.call(c => c.reducers.requestAgentJob({ jobId, projectId, prompt, context: canonicalJson(context) }));
    return jobId;
  }

  async compareRuns(baselineRunId: ID, candidateRunId: ID): Promise<RunComparison> {
    await this.call(c => c.reducers.openCompare({ baselineRunId, candidateRunId }));
    const conn = await this.ready;
    const deadline = Date.now() + 30_000;
    const find = (id: ID) => [...conn.db.activeCompareResults.iter()].find(r => r.runId === id);
    while (!(find(baselineRunId) && find(candidateRunId))) {
      if (Date.now() > deadline) throw new DomainError('NOT_FOUND', 'Both runs need finished results before they can be compared.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const load = (id: ID) => {
      const row = find(id)!;
      const metrics = JSON.parse(row.metrics) as SimulationMetrics;
      const bundle = decodeFieldBundle(row.fields);
      const values = bundle.fields['people.congestion/timeAverage'];
      const field: ScalarField | null = values ? { fieldId: 'people.congestion', aggregation: 'timeAverage', grid: bundle.grid, units: 'congestion index', values } : null;
      return { metrics, field };
    };
    const a = load(baselineRunId), b = load(candidateRunId);
    return {
      baselineRunId, candidateRunId, baseline: a.metrics, candidate: b.metrics, delta: metricsDelta(a.metrics, b.metrics),
      congestionDiff: a.field && b.field ? fieldDifference(a.field, b.field) : null,
    };
  }

  async acceptProposal(proposalId: ID) {
    await this.call(c => c.reducers.acceptProposal({ proposalId }));
  }

  async rejectProposal(proposalId: ID) {
    await this.call(c => c.reducers.rejectProposal({ proposalId }));
  }

  dispose() {
    clearInterval(this.runnerTimer);
    for (const p of this.playbacks.values()) p.dispose();
    this.conn?.disconnect();
  }
}

/** Running counts from the newest frame while the authoritative result is not in yet. */
function liveMetrics(runId: ID, playback: Playback): SimulationMetrics | null {
  const frames = playback.loadedFrames();
  const last = frames[frames.length - 1];
  if (!last) return null;
  let exited = 0;
  for (const f of last.actorFlags) if (f === ACTOR_EXITED) exited++;
  const n = last.actorFlags.length;
  return {
    runId, tick: last.tick, simulatedSeconds: last.tick / TICK_RATE_HZ, initialPeople: n, evacuatedPeople: exited, remainingPeople: n - exited,
    unreachablePeople: 0, evacuationTimeSeconds: null, maxQueueLength: 0, meanCongestion: 0, peakCongestion: 0, perExitThroughput: {},
    bottlenecks: [], complete: false,
  };
}
