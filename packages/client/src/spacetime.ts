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
  ACTOR_EXITED, canonicalJson, decodeChunk, decodeFieldBundle, DomainError, entitiesToDocument, fieldDifference, LOCKED_MESSAGE, locksEditing, metricsDelta,
  parseDocumentJson, sha256Hex, TICK_RATE_HZ, type PresenceMode, type ScalarField,
  type AgentContext, type DomainErrorData, type EditCommand, type EgressDocument, type Entity, type ID, type Pace, type Role, type RoomFacts, type RoomKind, type RoomLabel,
  type SimulationMetrics, type SimulationScenario,
} from '@egress/core';
import { Identity } from 'spacetimedb';
import { DbConnection, tables } from './bindings/index.ts';
import { ghostFor } from './ghost.ts';
import { OptimisticDocument } from './optimistic.ts';
import { Playback } from './playback.ts';
import { writable } from './store.ts';
import { parseProjectFile } from './stats.ts';
import type {
  AgentJob, AgentStep, ConnectionStatus, DocumentView, EditResult, EgressClient, Me, Member, ProjectStats, ProjectSummary, ProposalView, RunComparison, RunnerStatus, RunSummary,
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
/** A 128-bit random share code, base64url (22 characters). */
const shareCode = () => btoa(String.fromCharCode(...globalThis.crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
  readonly projectStats = writable<ProjectStats[]>([]);
  readonly members = writable<Member[]>([]);
  readonly roomLabels = writable<RoomLabel[]>([]);
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
  private layoutRowsChanged = true;
  private serverProject: ID | null = null;
  private serverRevision = -1;
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
              tables.myProjectStats, tables.previewEntities, tables.activeShareLink, tables.activePresence, tables.activeRoomLabels,
              tables.activePresenceModes,
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
      conn.db.myProfile, conn.db.mySession, conn.db.myProjects, conn.db.myMemberships,
      conn.db.activeRuns, conn.db.activeReplay, conn.db.activeResult, conn.db.activeAgentJobs, conn.db.activeAgentSteps, conn.db.activeProposals,
      conn.db.activeRunLayout, conn.db.runnerStatus, conn.db.activeCompareResults, conn.db.myProjectStats, conn.db.previewEntities, conn.db.activeShareLink, conn.db.activePresence, conn.db.activeRoomLabels,
      conn.db.activePresenceModes,
    ] as { onInsert(cb: () => void): void; onDelete(cb: () => void): void; onUpdate?: (cb: () => void) => void }[];
    // Replay chunks and presence changes must preserve the document object used by the renderer.
    const layoutChanged = () => { this.layoutRowsChanged = true; schedule(); };
    for (const table of [conn.db.activeEntities, conn.db.activeEditLog]) {
      table.onInsert(layoutChanged);
      table.onDelete(layoutChanged);
      if ('onUpdate' in table && typeof table.onUpdate === 'function') table.onUpdate(layoutChanged);
    }
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
    this.projectStats.set([...conn.db.myProjectStats.iter()].map(s => ({
      projectId: s.projectId, sizeBytes: s.sizeBytes, walls: s.walls, doors: s.doors, windows: s.windows, exits: s.exits,
      floors: s.floors, members: s.members, lastEvacuationSeconds: s.lastEvacuationSeconds < 0 ? null : s.lastEvacuationSeconds,
    })));

    const online = new Set([...conn.db.activePresence.iter()].map(p => p.identity.toHexString()));
    const modes = new Map([...conn.db.activePresenceModes.iter()].filter(p => p.projectId === this.activeProjectId).map(p => [p.identity.toHexString(), p.mode as PresenceMode]));
    const myIdentity = profile?.identity.toHexString();
    this.members.set([...conn.db.activeMembers.iter()].filter(m => m.projectId === this.activeProjectId).map(m => {
      const identity = m.identity.toHexString(), isOnline = online.has(identity);
      return { identity, role: m.role as Role, joinedAt: ms(m.joinedAt), online: isOnline, me: identity === myIdentity, mode: isOnline ? modes.get(identity) ?? null : null };
    }).sort((a, b) => Number(b.me) - Number(a.me) || Number(b.online) - Number(a.online) || a.joinedAt - b.joinedAt));

    this.roomLabels.set([...conn.db.activeRoomLabels.iter()].filter(l => l.projectId === this.activeProjectId).map(l => ({
      roomHash: l.roomHash, kind: l.kind as RoomKind, name: l.name, confidence: l.confidence, source: l.source as RoomLabel['source'],
    })));

    // Document: entity rows of the active project, with optimistic edits rebased on top.
    const project = projectRows.find(p => p.id === this.activeProjectId);
    if (project && (this.layoutRowsChanged || this.serverProject !== project.id || this.serverRevision !== Number(project.revision))) {
      const rows = [...conn.db.activeEntities.iter()].filter(r => r.projectId === project.id);
      const entities = rows.map(r => {
        const key = `${project.id}/${r.id}@${r.rev}:${r.payload.length}`;
        let e = this.parsedEntities.get(key);
        if (!e) { e = JSON.parse(r.payload) as Entity; this.parsedEntities.set(key, e); }
        return e;
      });
      const doc = entitiesToDocument(project.id, Number(project.revision), entities);
      this.od.setServer(doc, [...conn.db.activeEditLog.iter()].map(l => l.requestId));
      this.publishDocument();
    } else if (!project && (this.document.get().projectId !== this.activeProjectId || this.od.view)) {
      this.od.setServer(null);
      this.publishDocument();
    }
    this.layoutRowsChanged = false;
    this.serverProject = project?.id ?? null;
    this.serverRevision = project ? Number(project.revision) : -1;

    this.runs.set([...conn.db.activeRuns.iter()].map(r => {
      const scenario = parse<Partial<SimulationScenario>>(r.scenario, {});
      return {
        id: r.id, projectId: r.projectId, status: r.status as RunSummary['status'], pace: r.pace as Pace, seed: r.seed,
        scenarioName: scenario.name ?? 'Run', population: scenario.population?.count ?? 0, layoutRevision: Number(r.layoutRevision),
        elements: scenario.elements, windFrom: scenario.windFrom,
        progressTick: r.progressTick, agentJobId: r.agentJobId || null, createdAt: ms(r.createdAt), updatedAt: ms(r.updatedAt),
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

  async previewProject(projectId: ID) {
    await this.call(c => c.reducers.previewProject({ projectId }));
    const conn = await this.ready;
    const deadline = Date.now() + 8000;
    for (;;) {
      const rows = [...conn.db.previewEntities.iter()].filter(r => r.projectId === projectId);
      if (rows.length) {
        const project = [...conn.db.myProjects.iter()].find(p => p.id === projectId);
        return entitiesToDocument(projectId, Number(project?.revision ?? 0), rows.map(r => JSON.parse(r.payload) as Entity));
      }
      if (Date.now() > deadline) throw new DomainError('INTERNAL_ERROR', 'The project preview did not arrive in time.');
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }

  async renameProject(projectId: ID, name: string) {
    await this.call(c => c.reducers.renameProject({ projectId, name }));
  }

  async deleteProject(projectId: ID) {
    await this.call(c => c.reducers.deleteProject({ projectId }));
  }

  async importProject(name: string, json: string) {
    return this.createProject(name, parseProjectFile(json));
  }

  async joinProject(code: string) {
    await this.call(c => c.reducers.joinProject({ code }));
    this.refresh();
    return this.activeProjectId ?? '';
  }

  // ── room labels (PLAN.md §3 E) ──

  async requestRoomLabels(rooms: RoomFacts[]) {
    const projectId = this.activeProjectId;
    if (!projectId || !rooms.length) return;
    await this.call(c => c.reducers.requestRoomLabels({ projectId, rooms: JSON.stringify(rooms) }));
  }

  async setRoomLabel(roomHash: string, kind: RoomKind, name: string) {
    const projectId = this.activeProjectId;
    if (!projectId) throw new DomainError('NOT_FOUND', 'Open a project first.');
    await this.call(c => c.reducers.setRoomLabel({ projectId, roomHash, kind, name }));
  }

  // ── sharing (PLAN.md §3 C) ──

  /** Resolves once `read` returns a value from the subscribed caches. */
  private async waitFor<T>(read: () => T | undefined | null, what: string, ms = 8000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const value = read();
      if (value !== undefined && value !== null) return value;
      if (Date.now() > end) throw new DomainError('INTERNAL_ERROR', `Timed out waiting for ${what}.`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }

  private currentLink(projectId: ID) {
    return this.conn ? [...this.conn.db.activeShareLink.iter()].find(l => l.projectId === projectId)?.code : undefined;
  }

  async shareLink() {
    await this.ready;
    const projectId = this.activeProjectId;
    if (!projectId) throw new DomainError('NOT_FOUND', 'Open a project first.');
    if (!this.currentLink(projectId)) await this.call(c => c.reducers.ensureShareLink({ projectId, code: shareCode() }));
    return this.waitFor(() => this.currentLink(projectId), 'the share link');
  }

  async resetShareLink() {
    await this.ready;
    const projectId = this.activeProjectId;
    if (!projectId) throw new DomainError('NOT_FOUND', 'Open a project first.');
    const code = shareCode();
    await this.call(c => c.reducers.resetShareLink({ projectId, code }));
    return this.waitFor(() => (this.currentLink(projectId) === code ? code : undefined), 'the new share link');
  }

  async joinByLink(code: string) {
    await this.call(c => c.reducers.joinByLink({ code }));
    this.refresh();
    return this.waitFor(() => this.activeProjectId, 'the shared project');
  }

  async setMemberRole(identity: string, role: Role) {
    const projectId = this.activeProjectId;
    if (!projectId) throw new DomainError('NOT_FOUND', 'Open a project first.');
    await this.call(c => c.reducers.setMemberRole({ projectId, member: Identity.fromString(identity), role }));
  }

  async removeMember(identity: string) {
    const projectId = this.activeProjectId;
    if (!projectId) throw new DomainError('NOT_FOUND', 'Open a project first.');
    await this.call(c => c.reducers.removeMember({ projectId, member: Identity.fromString(identity) }));
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

  /** The open project's shared live run locks the layout (D89); refuse locally before any optimistic change. */
  private locked(): boolean {
    const now = Date.now();
    return this.runs.get().some(r => r.projectId === this.activeProjectId && locksEditing({ status: r.status, agentJobId: r.agentJobId, updatedAtMs: r.updatedAt }, now));
  }

  async setMode(mode: PresenceMode | null) {
    const projectId = mode ? this.activeProjectId : null;
    await this.call(c => c.reducers.setMode({ projectId: projectId ?? '', mode: mode ?? '' }));
  }

  private async send(commands: EditCommand[], history: 'record' | 'undo' | 'redo'): Promise<EditResult> {
    if (this.locked()) return { ok: false, error: { code: 'PROJECT_LOCKED', message: LOCKED_MESSAGE } };
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
