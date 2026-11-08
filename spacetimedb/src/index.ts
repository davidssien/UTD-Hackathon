/**
 * Egress SpacetimeDB module — the system of record (docs/ARCHITECTURE.md §5).
 *
 * - Every table is private. Clients read through views, write through reducers.
 * - A caller's `sessions` row (active project / run) scopes the `active_*` views.
 * - Building edits run the same pure `applyEdit` as the browser (D6).
 * - The runner proves itself once with a shared secret (`registerService`); its
 *   identity is then allowed to call the service-only reducers.
 */
import { schema, SenderError, t, table, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { Timestamp, type Identity } from 'spacetimedb';
import {
  applyEdit, canonicalJson, DomainError, emptyDocument, entitiesToDocument, documentToEntities, layoutHash, LOCKED_MESSAGE, locksEditing,
  parseDocumentJson, parseEditRequestJson, parseScenarioJson, parseWith, PaceSchema, PRESENCE_MODES, RoleSchema, sha256Hex, EditCommandSchema,
  type EgressDocument, type Entity, type Role,
} from '@egress/core';

/** sha256 of the runner's EGRESS_SERVICE_SECRET (services/runner/.env). Safe to commit. */
const SERVICE_SECRET_SHA256 = 'c9380efe6069912a7e937d0b3c6a93997c2b09f324ab9f65ad704dafe4634f91';
const MODEL_ID = 'egress-pedestrian';
const MODEL_VERSION = '0.2.0';

// ── Tables ──────────────────────────────────────────────────────────────────

const users = table({ name: 'users' }, {
  identity: t.identity().primaryKey(),
  displayName: t.string(),
  createdAt: t.timestamp(),
});

/** Which project/run the caller is looking at; scopes every `active_*` view. '' = none. */
const sessions = table({ name: 'sessions' }, {
  identity: t.identity().primaryKey(),
  activeProjectId: t.string().index(),
  activeRunId: t.string().index(),
});

const service_identities = table({ name: 'service_identities' }, {
  identity: t.identity().primaryKey(),
  role: t.string(),
  registeredAt: t.timestamp(),
});

const projects = table({ name: 'projects' }, {
  id: t.string().primaryKey(),
  name: t.string(),
  owner: t.identity(),
  revision: t.u64(),
  docVersion: t.u32(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

const project_members = table({ name: 'project_members' }, {
  id: t.u64().primaryKey().autoInc(),
  projectId: t.string().index(),
  identity: t.identity().index(),
  role: t.string(),
  joinedAt: t.timestamp(),
});

const project_invites = table({ name: 'project_invites' }, {
  codeHash: t.string().primaryKey(),
  projectId: t.string().index(),
  role: t.string(),
  createdBy: t.identity(),
  expiresAt: t.timestamp(),
  revoked: t.bool(),
});

/** One row per building entity; `payload` is the entity JSON validated by @egress/core. */
const entities = table({ name: 'entities' }, {
  id: t.string().primaryKey(),
  projectId: t.string().index(),
  kind: t.string(),
  payload: t.string(),
  rev: t.u64(),
});

const edit_log = table({ name: 'edit_log' }, {
  id: t.u64().primaryKey().autoInc(),
  projectId: t.string().index(),
  revision: t.u64(),
  requestId: t.string(),
  author: t.identity(),
  commands: t.string(),
  at: t.timestamp(),
});

const scenarios = table({ name: 'scenarios' }, {
  id: t.string().primaryKey(),
  projectId: t.string().index(),
  name: t.string(),
  payload: t.string(),
  updatedAt: t.timestamp(),
});

/** Immutable building documents referenced by runs; deduplicated by layout hash. */
const layout_snapshots = table({ name: 'layout_snapshots' }, {
  hash: t.string().primaryKey(),
  projectId: t.string().index(),
  revision: t.u64(),
  document: t.string(),
  createdAt: t.timestamp(),
});

const sim_runs = table({ name: 'sim_runs' }, {
  id: t.string().primaryKey(),
  projectId: t.string().index(),
  status: t.string().index(),
  layoutHash: t.string(),
  layoutRevision: t.u64(),
  scenario: t.string(),
  seed: t.u32(),
  modelId: t.string(),
  modelVersion: t.string(),
  pace: t.string(),
  /** '' for user runs; the agent job id for candidate/baseline runs started by the agent. */
  agentJobId: t.string(),
  requestedBy: t.identity(),
  claimedBy: t.string(),
  progressTick: t.u32(),
  chunkCount: t.u32(),
  errorCode: t.string(),
  errorMessage: t.string(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

/**
 * Row type of `my_project_stats` (saves page, PLAN.md §3 B). Computed at read time from the
 * project's rows; nothing writes this table.
 */
const project_stats = table({ name: 'project_stats' }, {
  projectId: t.string().primaryKey(),
  /** Approximate size of the project document: the sum of its entity JSON payloads. */
  sizeBytes: t.u32(),
  walls: t.u32(),
  doors: t.u32(),
  windows: t.u32(),
  exits: t.u32(),
  floors: t.u32(),
  members: t.u32(),
  /** Evacuation time of the latest finished user run; -1 when there is none. */
  lastEvacuationSeconds: t.f64(),
});

/** One permanent share link per project (PLAN.md §3 C). Joining through it gives viewer access. */
const project_links = table({ name: 'project_links' }, {
  projectId: t.string().primaryKey(),
  code: t.string().unique(),
  createdBy: t.identity(),
  createdAt: t.timestamp(),
});

/** Room kind and name per room outline hash (PLAN.md §3 E, D73). User labels are never overwritten by the model. */
const room_labels = table({ name: 'room_labels' }, {
  /** `${projectId}:${roomHash}` */
  id: t.string().primaryKey(),
  projectId: t.string().index(),
  roomHash: t.string(),
  kind: t.string(),
  name: t.string(),
  confidence: t.f64(),
  /** nemotron | rules | user */
  source: t.string(),
  updatedAt: t.timestamp(),
});

/** One pending labelling request per project; the runner answers with publish_room_labels. */
const label_requests = table({ name: 'label_requests' }, {
  projectId: t.string().primaryKey(),
  /** JSON array of RoomFacts (no outlines). */
  rooms: t.string(),
  status: t.string().index(),
  claimedBy: t.string(),
  requestedAt: t.timestamp(),
});

/** Live connections per identity, for presence. Rows exist only while connected. */
const online_connections = table({ name: 'online_connections' }, {
  identity: t.identity().primaryKey(),
  connections: t.u32(),
  since: t.timestamp(),
});

/** What each connected person is doing on their open project (PLAN.md §3 K): edit, simulate or analysis. */
const presence_modes = table({ name: 'presence_modes' }, {
  identity: t.identity().primaryKey(),
  projectId: t.string(),
  mode: t.string(),
  updatedAt: t.timestamp(),
});

/** Which project the caller previews on the saves page without opening it (`preview_entities`). */
const session_preview = table({ name: 'session_preview' }, {
  identity: t.identity().primaryKey(),
  projectId: t.string(),
});

const sim_results = table({ name: 'sim_results' }, {
  runId: t.string().primaryKey(),
  metrics: t.string(),
  /** gzip(Float32 fields): see @egress/sim result codec. */
  fields: t.byteArray(),
  grid: t.string(),
  createdAt: t.timestamp(),
});

const replay_chunks = table({ name: 'replay_chunks' }, {
  id: t.u64().primaryKey().autoInc(),
  runId: t.string().index(),
  chunkIndex: t.u32(),
  firstTick: t.u32(),
  lastTick: t.u32(),
  encoding: t.string(),
  bytes: t.byteArray(),
});

const agent_jobs = table({ name: 'agent_jobs' }, {
  id: t.string().primaryKey(),
  projectId: t.string().index(),
  status: t.string().index(),
  requestedBy: t.identity(),
  prompt: t.string(),
  context: t.string(),
  snapshotHash: t.string(),
  baseRevision: t.u64(),
  claimedBy: t.string(),
  summary: t.string(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

const agent_steps = table({ name: 'agent_steps' }, {
  id: t.u64().primaryKey().autoInc(),
  jobId: t.string().index(),
  projectId: t.string().index(),
  seq: t.u32(),
  kind: t.string(),
  toolName: t.string(),
  payload: t.string(),
  at: t.timestamp(),
});

const proposals = table({ name: 'proposals' }, {
  id: t.string().primaryKey(),
  projectId: t.string().index(),
  jobId: t.string(),
  baseRevision: t.u64(),
  commands: t.string(),
  notes: t.string(),
  baselineRunId: t.string(),
  candidateRunId: t.string(),
  delta: t.string(),
  status: t.string(),
  createdAt: t.timestamp(),
});

/** Liveness of each runner, so the UI can say "simulation server offline" instead of waiting forever. */
const runner_heartbeats = table({ name: 'runner_heartbeats' }, {
  identity: t.identity().primaryKey(),
  agentModel: t.string(),
  activeRuns: t.u32(),
  activeJobs: t.u32(),
  version: t.string(),
  lastSeen: t.timestamp(),
});

/** The pair of runs a caller is comparing in Analysis mode (baseline vs candidate). */
const session_compare = table({ name: 'session_compare' }, {
  identity: t.identity().primaryKey(),
  baselineRunId: t.string(),
  candidateRunId: t.string(),
});

const spacetimedb = schema({
  users, sessions, service_identities, projects, project_members, project_invites, entities, edit_log, scenarios,
  layout_snapshots, sim_runs, sim_results, replay_chunks, agent_jobs, agent_steps, proposals, runner_heartbeats, session_compare,
  project_stats, session_preview, project_links, online_connections, room_labels, label_requests, presence_modes,
});
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Run a reducer body, turning DomainErrors into SenderErrors ("CODE: message"). */
function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof DomainError) throw new SenderError(e.toWire());
    throw e;
  }
}

const fail = (code: ConstructorParameters<typeof DomainError>[0], message: string): never => {
  throw new DomainError(code, message);
};

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

function roleOf(ctx: Ctx, projectId: string, identity: Identity): Role | null {
  for (const m of ctx.db.project_members.projectId.filter(projectId)) {
    if (m.identity.isEqual(identity)) return m.role as Role;
  }
  return null;
}

function requireRole(ctx: Ctx, projectId: string, minimum: Role): Role {
  if (!ctx.db.projects.id.find(projectId)) fail('NOT_FOUND', `Project ${projectId} does not exist.`);
  const role = roleOf(ctx, projectId, ctx.sender);
  if (!role || ROLE_RANK[role] < ROLE_RANK[minimum]) fail('UNAUTHORIZED', `This needs ${minimum} access to the project.`);
  return role!;
}

function requireService(ctx: Ctx): void {
  if (!ctx.db.service_identities.identity.find(ctx.sender)) fail('UNAUTHORIZED', 'Only the Egress runner may call this.');
}

function ensureUser(ctx: Ctx): void {
  if (!ctx.db.users.identity.find(ctx.sender)) {
    ctx.db.users.insert({ identity: ctx.sender, displayName: `Guest ${ctx.sender.toHexString().slice(-4)}`, createdAt: ctx.timestamp });
  }
  if (!ctx.db.sessions.identity.find(ctx.sender)) {
    ctx.db.sessions.insert({ identity: ctx.sender, activeProjectId: '', activeRunId: '' });
  }
}

function setSession(ctx: Ctx, patch: { activeProjectId?: string; activeRunId?: string }): void {
  ensureUser(ctx);
  const s = ctx.db.sessions.identity.find(ctx.sender)!;
  ctx.db.sessions.identity.update({ ...s, ...patch });
}

function loadDocument(ctx: Ctx, projectId: string): EgressDocument {
  const project = ctx.db.projects.id.find(projectId) ?? fail('NOT_FOUND', `Project ${projectId} does not exist.`);
  const rows: Entity[] = [];
  for (const row of ctx.db.entities.projectId.filter(projectId)) rows.push(JSON.parse(row.payload) as Entity);
  return entitiesToDocument(projectId, Number(project!.revision), rows);
}

/** Persist `after` as rows (only the diff) and bump the project revision. */
function saveDocument(ctx: Ctx, projectId: string, put: Entity[], remove: string[], revision: number): void {
  const rev = BigInt(revision);
  for (const id of remove) ctx.db.entities.id.delete(id);
  for (const e of put) {
    const row = { id: e.id, projectId, kind: e.kind, payload: JSON.stringify(e), rev };
    if (ctx.db.entities.id.find(e.id)) ctx.db.entities.id.update(row);
    else ctx.db.entities.insert(row);
  }
  const project = ctx.db.projects.id.find(projectId)!;
  ctx.db.projects.id.update({ ...project, revision: rev, updatedAt: ctx.timestamp });
}

/** Freeze the project's current layout as an immutable snapshot (deduplicated by hash). */
function freezeSnapshot(ctx: Ctx, doc: EgressDocument): string {
  const hash = layoutHash(doc);
  if (!ctx.db.layout_snapshots.hash.find(hash)) {
    ctx.db.layout_snapshots.insert({ hash, projectId: doc.projectId, revision: BigInt(doc.revision), document: canonicalJson(doc), createdAt: ctx.timestamp });
  }
  return hash;
}

/** The project's shared live run, if one locks editing right now (D89). */
function lockingRun(ctx: Ctx, projectId: string) {
  const now = Number(ctx.timestamp.microsSinceUnixEpoch / 1000n);
  for (const run of ctx.db.sim_runs.projectId.filter(projectId)) {
    if (locksEditing({ status: run.status, agentJobId: run.agentJobId, updatedAtMs: Number(run.updatedAt.microsSinceUnixEpoch / 1000n) }, now)) return run;
  }
  return null;
}

function requireUnlocked(ctx: Ctx, projectId: string): void {
  if (lockingRun(ctx, projectId)) fail('PROJECT_LOCKED', LOCKED_MESSAGE);
}

function deleteRun(ctx: Ctx, runId: string): void {
  for (const c of [...ctx.db.replay_chunks.runId.filter(runId)]) ctx.db.replay_chunks.id.delete(c.id);
  ctx.db.sim_results.runId.delete(runId);
  ctx.db.sim_runs.id.delete(runId);
}

const cleanName = (name: string, what: string) => {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80) fail('INVALID_INPUT', `${what} must be 1–80 characters.`);
  return trimmed;
};

// ── Lifecycle ───────────────────────────────────────────────────────────────

export const init = spacetimedb.init(() => {});

export const onConnect = spacetimedb.clientConnected(ctx => {
  ensureUser(ctx);
  const online = ctx.db.online_connections.identity.find(ctx.sender);
  if (online) ctx.db.online_connections.identity.update({ ...online, connections: online.connections + 1 });
  else ctx.db.online_connections.insert({ identity: ctx.sender, connections: 1, since: ctx.timestamp });
});

export const onDisconnect = spacetimedb.clientDisconnected(ctx => {
  const online = ctx.db.online_connections.identity.find(ctx.sender);
  if (!online) return;
  if (online.connections <= 1) {
    ctx.db.online_connections.identity.delete(ctx.sender);
    ctx.db.presence_modes.identity.delete(ctx.sender);
  } else ctx.db.online_connections.identity.update({ ...online, connections: online.connections - 1 });
});

// ── Identity ────────────────────────────────────────────────────────────────

export const set_display_name = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => guard(() => {
  ensureUser(ctx);
  const user = ctx.db.users.identity.find(ctx.sender)!;
  ctx.db.users.identity.update({ ...user, displayName: cleanName(name, 'Display name') });
}));

export const register_service = spacetimedb.reducer({ secret: t.string() }, (ctx, { secret }) => guard(() => {
  if (sha256Hex(secret) !== SERVICE_SECRET_SHA256) fail('UNAUTHORIZED', 'Invalid service secret.');
  if (!ctx.db.service_identities.identity.find(ctx.sender)) {
    ctx.db.service_identities.insert({ identity: ctx.sender, role: 'runner', registeredAt: ctx.timestamp });
  }
}));

// ── Projects & membership ───────────────────────────────────────────────────

export const create_project = spacetimedb.reducer(
  { projectId: t.string(), name: t.string(), seedDocument: t.string() },
  (ctx, { projectId, name, seedDocument }) => guard(() => {
    ensureUser(ctx);
    if (!/^[A-Za-z0-9_.:-]{6,80}$/.test(projectId)) fail('INVALID_INPUT', 'Project id must be 6–80 URL-safe characters.');
    if (ctx.db.projects.id.find(projectId)) fail('INVALID_INPUT', 'A project with this id already exists.');
    const doc = seedDocument ? { ...parseDocumentJson(seedDocument), projectId, revision: 0 } : emptyDocument(projectId);
    ctx.db.projects.insert({
      id: projectId, name: cleanName(name, 'Project name'), owner: ctx.sender, revision: 0n, docVersion: 1,
      createdAt: ctx.timestamp, updatedAt: ctx.timestamp,
    });
    ctx.db.project_members.insert({ id: 0n, projectId, identity: ctx.sender, role: 'owner', joinedAt: ctx.timestamp });
    saveDocument(ctx, projectId, documentToEntities(doc), [], 0);
    setSession(ctx, { activeProjectId: projectId, activeRunId: '' });
  }),
);

export const rename_project = spacetimedb.reducer({ projectId: t.string(), name: t.string() }, (ctx, { projectId, name }) => guard(() => {
  requireRole(ctx, projectId, 'editor');
  const project = ctx.db.projects.id.find(projectId)!;
  ctx.db.projects.id.update({ ...project, name: cleanName(name, 'Project name'), updatedAt: ctx.timestamp });
}));

export const delete_project = spacetimedb.reducer({ projectId: t.string() }, (ctx, { projectId }) => guard(() => {
  requireRole(ctx, projectId, 'owner');
  for (const r of [...ctx.db.entities.projectId.filter(projectId)]) ctx.db.entities.id.delete(r.id);
  for (const r of [...ctx.db.project_members.projectId.filter(projectId)]) ctx.db.project_members.id.delete(r.id);
  for (const r of [...ctx.db.project_invites.projectId.filter(projectId)]) ctx.db.project_invites.codeHash.delete(r.codeHash);
  for (const r of [...ctx.db.edit_log.projectId.filter(projectId)]) ctx.db.edit_log.id.delete(r.id);
  for (const r of [...ctx.db.scenarios.projectId.filter(projectId)]) ctx.db.scenarios.id.delete(r.id);
  for (const r of [...ctx.db.sim_runs.projectId.filter(projectId)]) deleteRun(ctx, r.id);
  for (const r of [...ctx.db.proposals.projectId.filter(projectId)]) ctx.db.proposals.id.delete(r.id);
  for (const r of [...ctx.db.agent_steps.projectId.filter(projectId)]) ctx.db.agent_steps.id.delete(r.id);
  for (const r of [...ctx.db.agent_jobs.projectId.filter(projectId)]) ctx.db.agent_jobs.id.delete(r.id);
  for (const s of [...ctx.db.sessions.activeProjectId.filter(projectId)]) ctx.db.sessions.identity.update({ ...s, activeProjectId: '', activeRunId: '' });
  for (const p of [...ctx.db.session_preview.iter()]) if (p.projectId === projectId) ctx.db.session_preview.identity.delete(p.identity);
  if (ctx.db.project_links.projectId.find(projectId)) ctx.db.project_links.projectId.delete(projectId);
  for (const l of [...ctx.db.room_labels.projectId.filter(projectId)]) ctx.db.room_labels.id.delete(l.id);
  if (ctx.db.label_requests.projectId.find(projectId)) ctx.db.label_requests.projectId.delete(projectId);
  for (const p of [...ctx.db.presence_modes.iter()]) if (p.projectId === projectId) ctx.db.presence_modes.identity.delete(p.identity);
  ctx.db.projects.id.delete(projectId);
}));

/** The client generates the code, shares it out of band, and sends only its sha256. */
export const create_invite = spacetimedb.reducer(
  { projectId: t.string(), role: t.string(), codeHash: t.string(), ttlHours: t.u32() },
  (ctx, { projectId, role, codeHash, ttlHours }) => guard(() => {
    requireRole(ctx, projectId, 'owner');
    const parsed = parseWith(RoleSchema, role, 'role');
    if (parsed === 'owner') fail('INVALID_INPUT', 'Invites can grant editor or viewer access.');
    if (!/^[0-9a-f]{64}$/.test(codeHash)) fail('INVALID_INPUT', 'Invite code hash must be sha256 hex.');
    const hours = Math.min(Math.max(ttlHours, 1), 24 * 14);
    ctx.db.project_invites.insert({
      codeHash, projectId, role: parsed, createdBy: ctx.sender, revoked: false,
      expiresAt: new Timestamp(ctx.timestamp.microsSinceUnixEpoch + BigInt(hours) * 3_600_000_000n),
    });
  }),
);

export const revoke_invite = spacetimedb.reducer({ codeHash: t.string() }, (ctx, { codeHash }) => guard(() => {
  const invite = ctx.db.project_invites.codeHash.find(codeHash) ?? fail('NOT_FOUND', 'Invite not found.');
  requireRole(ctx, invite!.projectId, 'owner');
  ctx.db.project_invites.codeHash.update({ ...invite!, revoked: true });
}));

export const join_project = spacetimedb.reducer({ code: t.string() }, (ctx, { code }) => guard(() => {
  ensureUser(ctx);
  const invite = ctx.db.project_invites.codeHash.find(sha256Hex(code.trim()));
  if (!invite || invite.revoked || invite.expiresAt.microsSinceUnixEpoch < ctx.timestamp.microsSinceUnixEpoch) {
    fail('UNAUTHORIZED', 'This invite code is invalid or has expired.');
  }
  const current = roleOf(ctx, invite!.projectId, ctx.sender);
  if (!current) {
    ctx.db.project_members.insert({ id: 0n, projectId: invite!.projectId, identity: ctx.sender, role: invite!.role, joinedAt: ctx.timestamp });
  } else if (ROLE_RANK[invite!.role as Role] > ROLE_RANK[current]) {
    for (const m of ctx.db.project_members.projectId.filter(invite!.projectId)) {
      if (m.identity.isEqual(ctx.sender)) ctx.db.project_members.id.update({ ...m, role: invite!.role });
    }
  }
  setSession(ctx, { activeProjectId: invite!.projectId, activeRunId: '' });
}));

// ── Room labels (D73) ───────────────────────────────────────────────────────

const ROOM_HASH = /^[0-9a-f]{16}$/;
const ROOM_KINDS = new Set(['room', 'hallway', 'stair', 'closet', 'lobby', 'other']);

/** Editors ask for labels of the rooms they have; the runner labels them with Nemotron or the rules. */
export const request_room_labels = spacetimedb.reducer({ projectId: t.string(), rooms: t.string() }, (ctx, { projectId, rooms }) => guard(() => {
  requireRole(ctx, projectId, 'editor');
  if (rooms.length > 64_000) fail('INVALID_INPUT', 'Too many rooms to label at once.');
  const list = JSON.parse(rooms) as unknown;
  if (!Array.isArray(list) || list.length > 200 || list.some(r => !ROOM_HASH.test(String((r as { roomHash?: unknown })?.roomHash)))) fail('INVALID_INPUT', 'Room facts must be an array of up to 200 rooms with a roomHash.');
  const row = { projectId, rooms, status: 'queued', claimedBy: '', requestedAt: ctx.timestamp };
  if (ctx.db.label_requests.projectId.find(projectId)) ctx.db.label_requests.projectId.update(row);
  else ctx.db.label_requests.insert(row);
}));

export const claim_label_request = spacetimedb.reducer({ projectId: t.string() }, (ctx, { projectId }) => guard(() => {
  requireService(ctx);
  const req = ctx.db.label_requests.projectId.find(projectId) ?? fail('NOT_FOUND', 'No label request.');
  if (req!.status !== 'queued') fail('INVALID_INPUT', 'Already claimed.');
  ctx.db.label_requests.projectId.update({ ...req!, status: 'running', claimedBy: ctx.sender.toHexString() });
}));

function putLabel(ctx: Ctx, projectId: string, label: { roomHash: string; kind: string; name: string; confidence: number }, source: string) {
  if (!ROOM_HASH.test(label.roomHash) || !ROOM_KINDS.has(label.kind)) fail('INVALID_INPUT', 'Unknown room hash or kind.');
  const name = cleanName(label.name, 'Room name').slice(0, 60);
  const id = `${projectId}:${label.roomHash}`;
  const existing = ctx.db.room_labels.id.find(id);
  if (existing && existing.source === 'user' && source !== 'user') return; // people's labels win
  const row = { id, projectId, roomHash: label.roomHash, kind: label.kind, name, confidence: Math.min(1, Math.max(0, label.confidence)), source, updatedAt: ctx.timestamp };
  if (existing) ctx.db.room_labels.id.update(row);
  else ctx.db.room_labels.insert(row);
}

export const publish_room_labels = spacetimedb.reducer({ projectId: t.string(), labels: t.string(), source: t.string() }, (ctx, { projectId, labels, source }) => guard(() => {
  requireService(ctx);
  if (!ctx.db.projects.id.find(projectId)) return;
  if (source !== 'nemotron' && source !== 'rules') fail('INVALID_INPUT', 'Source must be nemotron or rules.');
  const list = JSON.parse(labels) as { roomHash: string; kind: string; name: string; confidence: number }[];
  if (!Array.isArray(list) || list.length > 200) fail('INVALID_INPUT', 'Labels must be an array of up to 200.');
  for (const label of list) putLabel(ctx, projectId, label, source);
  const req = ctx.db.label_requests.projectId.find(projectId);
  if (req) ctx.db.label_requests.projectId.update({ ...req, status: 'done' });
}));

/** Editors can correct a room's kind and name; the model never overwrites it afterwards. */
export const set_room_label = spacetimedb.reducer(
  { projectId: t.string(), roomHash: t.string(), kind: t.string(), name: t.string() },
  (ctx, { projectId, roomHash, kind, name }) => guard(() => {
    requireRole(ctx, projectId, 'editor');
    putLabel(ctx, projectId, { roomHash, kind, name, confidence: 1 }, 'user');
  }),
);

const LINK_CODE = /^[A-Za-z0-9_-]{22,64}$/;

/**
 * Makes sure the project has its permanent share link. The client proposes a random code
 * (≥ 128 bits); if a link already exists it is kept, so concurrent callers converge on one.
 */
export const ensure_share_link = spacetimedb.reducer({ projectId: t.string(), code: t.string() }, (ctx, { projectId, code }) => guard(() => {
  requireRole(ctx, projectId, 'viewer');
  if (ctx.db.project_links.projectId.find(projectId)) return;
  if (!LINK_CODE.test(code)) fail('INVALID_INPUT', 'Share codes must be 22–64 URL-safe characters.');
  if (ctx.db.project_links.code.find(code)) fail('INVALID_INPUT', 'That share code is taken.');
  ctx.db.project_links.insert({ projectId, code, createdBy: ctx.sender, createdAt: ctx.timestamp });
}));

/** Owners can replace the link; the old one stops working at once. Members keep their access. */
export const reset_share_link = spacetimedb.reducer({ projectId: t.string(), code: t.string() }, (ctx, { projectId, code }) => guard(() => {
  requireRole(ctx, projectId, 'owner');
  if (!LINK_CODE.test(code)) fail('INVALID_INPUT', 'Share codes must be 22–64 URL-safe characters.');
  if (ctx.db.project_links.code.find(code)) fail('INVALID_INPUT', 'That share code is taken.');
  if (ctx.db.project_links.projectId.find(projectId)) ctx.db.project_links.projectId.delete(projectId);
  ctx.db.project_links.insert({ projectId, code, createdBy: ctx.sender, createdAt: ctx.timestamp });
}));

/** Joining through a share link always gives viewer access (owners may promote later). */
export const join_by_link = spacetimedb.reducer({ code: t.string() }, (ctx, { code }) => guard(() => {
  ensureUser(ctx);
  const link = LINK_CODE.test(code) ? ctx.db.project_links.code.find(code) : undefined;
  if (!link) fail('NOT_FOUND', 'This share link is not valid. Ask an owner for a new one.');
  if (!roleOf(ctx, link!.projectId, ctx.sender)) {
    ctx.db.project_members.insert({ id: 0n, projectId: link!.projectId, identity: ctx.sender, role: 'viewer', joinedAt: ctx.timestamp });
  }
  setSession(ctx, { activeProjectId: link!.projectId, activeRunId: '' });
}));

export const set_member_role = spacetimedb.reducer(
  { projectId: t.string(), member: t.identity(), role: t.string() },
  (ctx, { projectId, member, role }) => guard(() => {
    requireRole(ctx, projectId, 'owner');
    const parsed = parseWith(RoleSchema, role, 'role');
    const rows = [...ctx.db.project_members.projectId.filter(projectId)];
    const target = rows.find(m => m.identity.isEqual(member)) ?? fail('NOT_FOUND', 'Not a member of this project.');
    if (target!.role === 'owner' && parsed !== 'owner' && rows.filter(m => m.role === 'owner').length === 1) {
      fail('INVALID_INPUT', 'A project needs at least one owner.');
    }
    ctx.db.project_members.id.update({ ...target!, role: parsed });
  }),
);

export const remove_member = spacetimedb.reducer({ projectId: t.string(), member: t.identity() }, (ctx, { projectId, member }) => guard(() => {
  if (!member.isEqual(ctx.sender)) requireRole(ctx, projectId, 'owner');
  const rows = [...ctx.db.project_members.projectId.filter(projectId)];
  const target = rows.find(m => m.identity.isEqual(member)) ?? fail('NOT_FOUND', 'Not a member of this project.');
  if (target!.role === 'owner' && rows.filter(m => m.role === 'owner').length === 1) fail('INVALID_INPUT', 'A project needs at least one owner.');
  ctx.db.project_members.id.delete(target!.id);
  const session = ctx.db.sessions.identity.find(member);
  if (session && session.activeProjectId === projectId) ctx.db.sessions.identity.update({ ...session, activeProjectId: '', activeRunId: '' });
}));

// ── Sessions ────────────────────────────────────────────────────────────────

/** Saves page: show a project's plan and details without opening it. '' clears the preview. */
export const preview_project = spacetimedb.reducer({ projectId: t.string() }, (ctx, { projectId }) => guard(() => {
  const row = ctx.db.session_preview.identity.find(ctx.sender);
  if (!projectId) { if (row) ctx.db.session_preview.identity.delete(ctx.sender); return; }
  requireRole(ctx, projectId, 'viewer');
  if (row) ctx.db.session_preview.identity.update({ identity: ctx.sender, projectId });
  else ctx.db.session_preview.insert({ identity: ctx.sender, projectId });
}));

export const open_project = spacetimedb.reducer({ projectId: t.string() }, (ctx, { projectId }) => guard(() => {
  if (projectId) requireRole(ctx, projectId, 'viewer');
  setSession(ctx, { activeProjectId: projectId, activeRunId: '' });
}));

/** Presence by mode (PLAN.md §3 K). '' clears it, for example when going back to the saves page. */
export const set_mode = spacetimedb.reducer({ projectId: t.string(), mode: t.string() }, (ctx, { projectId, mode }) => guard(() => {
  if (!projectId) { ctx.db.presence_modes.identity.delete(ctx.sender); return; }
  requireRole(ctx, projectId, 'viewer');
  if (!(PRESENCE_MODES as readonly string[]).includes(mode)) fail('INVALID_INPUT', `Mode must be one of ${PRESENCE_MODES.join(', ')}.`);
  const row = { identity: ctx.sender, projectId, mode, updatedAt: ctx.timestamp };
  if (ctx.db.presence_modes.identity.find(ctx.sender)) ctx.db.presence_modes.identity.update(row);
  else ctx.db.presence_modes.insert(row);
}));

export const open_run = spacetimedb.reducer({ runId: t.string() }, (ctx, { runId }) => guard(() => {
  if (runId) {
    const run = ctx.db.sim_runs.id.find(runId) ?? fail('NOT_FOUND', `Run ${runId} does not exist.`);
    requireRole(ctx, run!.projectId, 'viewer');
    setSession(ctx, { activeProjectId: run!.projectId, activeRunId: runId });
  } else {
    setSession(ctx, { activeRunId: '' });
  }
}));

// ── Editing ─────────────────────────────────────────────────────────────────

export const apply_edit = spacetimedb.reducer({ request: t.string() }, (ctx, { request }) => guard(() => {
  const req = parseEditRequestJson(request);
  requireRole(ctx, req.projectId, 'editor');
  requireUnlocked(ctx, req.projectId);
  const doc = loadDocument(ctx, req.projectId);
  const result = applyEdit(doc, req);
  if (!result.ok) throw new DomainError(result.error.code, result.error.message, result.error.details);
  if (result.doc.revision === doc.revision) return;
  const put = [...result.changed, ...result.created.flat()].map(id => findIn(result.doc, id)).filter((e): e is Entity => !!e);
  saveDocument(ctx, req.projectId, dedupe(put), result.removed, result.doc.revision);
  ctx.db.edit_log.insert({
    id: 0n, projectId: req.projectId, revision: BigInt(result.doc.revision), requestId: req.requestId,
    author: ctx.sender, commands: JSON.stringify(req.commands), at: ctx.timestamp,
  });
}));

/** Any entity kind, floor surfaces and stairs included (D74, D75). */
function findIn(doc: EgressDocument, id: string): Entity | undefined {
  return documentToEntities(doc).find(e => e.id === id);
}

function dedupe(list: Entity[]): Entity[] {
  const seen = new Set<string>();
  return list.filter(e => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}

// ── Scenarios & runs ────────────────────────────────────────────────────────

export const save_scenario = spacetimedb.reducer({ scenario: t.string() }, (ctx, { scenario }) => guard(() => {
  const s = parseScenarioJson(scenario);
  requireRole(ctx, s.projectId, 'editor');
  const existing = ctx.db.scenarios.id.find(s.id);
  if (existing && existing.projectId !== s.projectId) fail('UNAUTHORIZED', 'Scenario belongs to another project.');
  const row = { id: s.id, projectId: s.projectId, name: s.name, payload: canonicalJson(s), updatedAt: ctx.timestamp };
  if (existing) ctx.db.scenarios.id.update(row);
  else ctx.db.scenarios.insert(row);
}));

export const request_simulation = spacetimedb.reducer(
  { runId: t.string(), scenario: t.string(), pace: t.string() },
  (ctx, { runId, scenario, pace }) => guard(() => {
    const s = parseScenarioJson(scenario);
    requireRole(ctx, s.projectId, 'editor');
    const parsedPace = parseWith(PaceSchema, pace, 'pace');
    if (!/^[A-Za-z0-9_.:-]{6,80}$/.test(runId) || ctx.db.sim_runs.id.find(runId)) fail('INVALID_INPUT', 'Run id must be new and URL-safe.');
    // One shared live simulation per project (D89).
    if (lockingRun(ctx, s.projectId)) fail('PROJECT_LOCKED', 'A simulation is already running on this project. Everyone on Simulate is following it.');
    const doc = loadDocument(ctx, s.projectId);
    const hash = freezeSnapshot(ctx, doc);
    ctx.db.sim_runs.insert({
      id: runId, projectId: s.projectId, status: 'queued', layoutHash: hash, layoutRevision: BigInt(doc.revision),
      scenario: canonicalJson(s), seed: s.population.seed, modelId: MODEL_ID, modelVersion: MODEL_VERSION, pace: parsedPace,
      agentJobId: '', requestedBy: ctx.sender, claimedBy: '', progressTick: 0, chunkCount: 0, errorCode: '', errorMessage: '',
      createdAt: ctx.timestamp, updatedAt: ctx.timestamp,
    });
    setSession(ctx, { activeProjectId: s.projectId, activeRunId: runId });
  }),
);

export const cancel_simulation = spacetimedb.reducer({ runId: t.string() }, (ctx, { runId }) => guard(() => {
  const run = ctx.db.sim_runs.id.find(runId) ?? fail('NOT_FOUND', `Run ${runId} does not exist.`);
  requireRole(ctx, run!.projectId, 'editor');
  if (run!.status === 'queued' || run!.status === 'running') {
    ctx.db.sim_runs.id.update({ ...run!, status: 'cancelled', updatedAt: ctx.timestamp });
  }
}));

// ── Runner-only: simulation ─────────────────────────────────────────────────

export const claim_simulation = spacetimedb.reducer({ runId: t.string() }, (ctx, { runId }) => guard(() => {
  requireService(ctx);
  const run = ctx.db.sim_runs.id.find(runId) ?? fail('NOT_FOUND', `Run ${runId} does not exist.`);
  if (run!.status !== 'queued') fail('INVALID_INPUT', `Run ${runId} is ${run!.status}, not queued.`);
  ctx.db.sim_runs.id.update({ ...run!, status: 'running', claimedBy: ctx.sender.toHexString(), updatedAt: ctx.timestamp });
}));

function claimedRun(ctx: Ctx, runId: string) {
  requireService(ctx);
  const run = ctx.db.sim_runs.id.find(runId) ?? fail('NOT_FOUND', `Run ${runId} does not exist.`);
  if (run!.claimedBy !== ctx.sender.toHexString()) fail('UNAUTHORIZED', 'This run is claimed by another runner.');
  return run!;
}

export const append_replay_chunk = spacetimedb.reducer(
  { runId: t.string(), chunkIndex: t.u32(), firstTick: t.u32(), lastTick: t.u32(), encoding: t.string(), bytes: t.byteArray() },
  (ctx, args) => guard(() => {
    const run = claimedRun(ctx, args.runId);
    if (run.status !== 'running') fail('INVALID_INPUT', `Run ${args.runId} is ${run.status}.`);
    ctx.db.replay_chunks.insert({ id: 0n, ...args });
    ctx.db.sim_runs.id.update({ ...run, progressTick: args.lastTick, chunkCount: Math.max(run.chunkCount, args.chunkIndex + 1), updatedAt: ctx.timestamp });
  }),
);

export const publish_run_result = spacetimedb.reducer(
  { runId: t.string(), metrics: t.string(), fields: t.byteArray(), grid: t.string() },
  (ctx, { runId, metrics, fields, grid }) => guard(() => {
    const run = claimedRun(ctx, runId);
    const row = { runId, metrics, fields, grid, createdAt: ctx.timestamp };
    if (ctx.db.sim_results.runId.find(runId)) ctx.db.sim_results.runId.update(row);
    else ctx.db.sim_results.insert(row);
    if (run.status === 'running') ctx.db.sim_runs.id.update({ ...run, status: 'complete', updatedAt: ctx.timestamp });
  }),
);

export const fail_simulation = spacetimedb.reducer(
  { runId: t.string(), code: t.string(), message: t.string() },
  (ctx, { runId, code, message }) => guard(() => {
    const run = claimedRun(ctx, runId);
    ctx.db.sim_runs.id.update({ ...run, status: 'failed', errorCode: code.slice(0, 64), errorMessage: message.slice(0, 1000), updatedAt: ctx.timestamp });
  }),
);

/** Agent-initiated run on an arbitrary (candidate) layout; created already claimed by the runner. */
export const start_agent_run = spacetimedb.reducer(
  { runId: t.string(), jobId: t.string(), document: t.string(), scenario: t.string() },
  (ctx, { runId, jobId, document, scenario }) => guard(() => {
    requireService(ctx);
    const job = ctx.db.agent_jobs.id.find(jobId) ?? fail('NOT_FOUND', `Agent job ${jobId} does not exist.`);
    const doc = { ...parseDocumentJson(document), projectId: job!.projectId };
    const s = parseScenarioJson(scenario);
    if (ctx.db.sim_runs.id.find(runId)) fail('INVALID_INPUT', 'Run id already exists.');
    const hash = freezeSnapshot(ctx, doc);
    ctx.db.sim_runs.insert({
      id: runId, projectId: job!.projectId, status: 'running', layoutHash: hash, layoutRevision: BigInt(doc.revision),
      scenario: canonicalJson({ ...s, projectId: job!.projectId }), seed: s.population.seed, modelId: MODEL_ID, modelVersion: MODEL_VERSION,
      pace: 'unpaced', agentJobId: jobId, requestedBy: job!.requestedBy, claimedBy: ctx.sender.toHexString(), progressTick: 0, chunkCount: 0,
      errorCode: '', errorMessage: '', createdAt: ctx.timestamp, updatedAt: ctx.timestamp,
    });
  }),
);

// ── Agent ───────────────────────────────────────────────────────────────────

export const request_agent_job = spacetimedb.reducer(
  { jobId: t.string(), projectId: t.string(), prompt: t.string(), context: t.string() },
  (ctx, { jobId, projectId, prompt, context }) => guard(() => {
    requireRole(ctx, projectId, 'editor');
    if (!/^[A-Za-z0-9_.:-]{6,80}$/.test(jobId) || ctx.db.agent_jobs.id.find(jobId)) fail('INVALID_INPUT', 'Job id must be new and URL-safe.');
    if (!prompt.trim() || prompt.length > 4000) fail('INVALID_INPUT', 'Prompt must be 1–4000 characters.');
    const doc = loadDocument(ctx, projectId);
    ctx.db.agent_jobs.insert({
      id: jobId, projectId, status: 'queued', requestedBy: ctx.sender, prompt: prompt.trim(), context: context || '{}',
      snapshotHash: freezeSnapshot(ctx, doc), baseRevision: BigInt(doc.revision), claimedBy: '', summary: '',
      createdAt: ctx.timestamp, updatedAt: ctx.timestamp,
    });
  }),
);

export const claim_agent_job = spacetimedb.reducer({ jobId: t.string() }, (ctx, { jobId }) => guard(() => {
  requireService(ctx);
  const job = ctx.db.agent_jobs.id.find(jobId) ?? fail('NOT_FOUND', `Agent job ${jobId} does not exist.`);
  if (job!.status !== 'queued') fail('INVALID_INPUT', `Agent job ${jobId} is ${job!.status}.`);
  ctx.db.agent_jobs.id.update({ ...job!, status: 'running', claimedBy: ctx.sender.toHexString(), updatedAt: ctx.timestamp });
}));

function claimedJob(ctx: Ctx, jobId: string) {
  requireService(ctx);
  const job = ctx.db.agent_jobs.id.find(jobId) ?? fail('NOT_FOUND', `Agent job ${jobId} does not exist.`);
  if (job!.claimedBy !== ctx.sender.toHexString()) fail('UNAUTHORIZED', 'This job is claimed by another runner.');
  return job!;
}

export const append_agent_step = spacetimedb.reducer(
  { jobId: t.string(), seq: t.u32(), kind: t.string(), toolName: t.string(), payload: t.string() },
  (ctx, { jobId, seq, kind, toolName, payload }) => guard(() => {
    const job = claimedJob(ctx, jobId);
    ctx.db.agent_steps.insert({ id: 0n, jobId, projectId: job.projectId, seq, kind, toolName, payload: payload.slice(0, 20000), at: ctx.timestamp });
  }),
);

export const publish_proposal = spacetimedb.reducer(
  {
    proposalId: t.string(), jobId: t.string(), commands: t.string(), notes: t.string(),
    baselineRunId: t.string(), candidateRunId: t.string(), delta: t.string(),
  },
  (ctx, args) => guard(() => {
    const job = claimedJob(ctx, args.jobId);
    const commands = JSON.parse(args.commands) as unknown[];
    if (!Array.isArray(commands) || commands.length === 0) fail('INVALID_INPUT', 'A proposal needs at least one command.');
    for (const c of commands) parseWith(EditCommandSchema, c, 'proposal command');
    ctx.db.proposals.insert({
      id: args.proposalId, projectId: job.projectId, jobId: args.jobId, baseRevision: job.baseRevision, commands: args.commands,
      notes: args.notes, baselineRunId: args.baselineRunId, candidateRunId: args.candidateRunId, delta: args.delta,
      status: 'proposed', createdAt: ctx.timestamp,
    });
  }),
);

export const finish_agent_job = spacetimedb.reducer(
  { jobId: t.string(), status: t.string(), summary: t.string() },
  (ctx, { jobId, status, summary }) => guard(() => {
    const job = claimedJob(ctx, jobId);
    if (status !== 'complete' && status !== 'failed') fail('INVALID_INPUT', 'Status must be complete or failed.');
    ctx.db.agent_jobs.id.update({ ...job, status, summary: summary.slice(0, 4000), updatedAt: ctx.timestamp });
  }),
);

/** Choose two runs of the same project to compare (both '' clears). */
export const open_compare = spacetimedb.reducer({ baselineRunId: t.string(), candidateRunId: t.string() }, (ctx, { baselineRunId, candidateRunId }) => guard(() => {
  for (const id of [baselineRunId, candidateRunId]) {
    if (!id) continue;
    const run = ctx.db.sim_runs.id.find(id) ?? fail('NOT_FOUND', `Run ${id} does not exist.`);
    requireRole(ctx, run!.projectId, 'viewer');
  }
  const row = { identity: ctx.sender, baselineRunId, candidateRunId };
  if (ctx.db.session_compare.identity.find(ctx.sender)) ctx.db.session_compare.identity.update(row);
  else ctx.db.session_compare.insert(row);
}));

/** Runner liveness ping (every few seconds). */
export const runner_heartbeat = spacetimedb.reducer(
  { agentModel: t.string(), activeRuns: t.u32(), activeJobs: t.u32(), version: t.string() },
  (ctx, args) => guard(() => {
    requireService(ctx);
    const row = { identity: ctx.sender, agentModel: args.agentModel.slice(0, 120), activeRuns: args.activeRuns, activeJobs: args.activeJobs, version: args.version.slice(0, 40), lastSeen: ctx.timestamp };
    if (ctx.db.runner_heartbeats.identity.find(ctx.sender)) ctx.db.runner_heartbeats.identity.update(row);
    else ctx.db.runner_heartbeats.insert(row);
  }),
);

/** Applies the proposal with requestId = proposalId, so ids match the ghost preview (D19). */
export const accept_proposal = spacetimedb.reducer({ proposalId: t.string() }, (ctx, { proposalId }) => guard(() => {
  const proposal = ctx.db.proposals.id.find(proposalId) ?? fail('NOT_FOUND', `Proposal ${proposalId} does not exist.`);
  requireRole(ctx, proposal!.projectId, 'editor');
  if (proposal!.status !== 'proposed') fail('INVALID_INPUT', `Proposal is already ${proposal!.status}.`);
  requireUnlocked(ctx, proposal!.projectId);
  const doc = loadDocument(ctx, proposal!.projectId);
  const commands = JSON.parse(proposal!.commands);
  const result = applyEdit(doc, { requestId: proposalId, commands });
  if (!result.ok) {
    // Do not throw: the stale status must persist so the UI can say so.
    ctx.db.proposals.id.update({ ...proposal!, status: 'stale' });
    return;
  }
  const put = [...result.changed, ...result.created.flat()].map(id => findIn(result.doc, id)).filter((e): e is Entity => !!e);
  saveDocument(ctx, proposal!.projectId, dedupe(put), result.removed, result.doc.revision);
  ctx.db.edit_log.insert({
    id: 0n, projectId: proposal!.projectId, revision: BigInt(result.doc.revision), requestId: proposalId,
    author: ctx.sender, commands: proposal!.commands, at: ctx.timestamp,
  });
  ctx.db.proposals.id.update({ ...proposal!, status: 'accepted' });
}));

export const reject_proposal = spacetimedb.reducer({ proposalId: t.string() }, (ctx, { proposalId }) => guard(() => {
  const proposal = ctx.db.proposals.id.find(proposalId) ?? fail('NOT_FOUND', `Proposal ${proposalId} does not exist.`);
  requireRole(ctx, proposal!.projectId, 'editor');
  if (proposal!.status === 'proposed') ctx.db.proposals.id.update({ ...proposal!, status: 'rejected' });
}));

// ── Views (per caller) ──────────────────────────────────────────────────────

export const my_profile = spacetimedb.view({ name: 'my_profile', public: true }, t.array(users.rowType), ctx =>
  ctx.from.users.where(u => u.identity.eq(ctx.sender)).build());

export const my_session = spacetimedb.view({ name: 'my_session', public: true }, t.array(sessions.rowType), ctx =>
  ctx.from.sessions.where(s => s.identity.eq(ctx.sender)).build());

export const my_memberships = spacetimedb.view({ name: 'my_memberships', public: true }, t.array(project_members.rowType), ctx =>
  ctx.from.project_members.where(m => m.identity.eq(ctx.sender)).build());

export const my_projects = spacetimedb.view({ name: 'my_projects', public: true }, t.array(projects.rowType), ctx =>
  ctx.from.project_members.where(m => m.identity.eq(ctx.sender)).rightSemijoin(ctx.from.projects, (m, p) => m.projectId.eq(p.id)).build());

export const active_members = spacetimedb.view({ name: 'active_members', public: true }, t.array(project_members.rowType), ctx =>
  ctx.from.sessions.where(s => s.identity.eq(ctx.sender)).rightSemijoin(ctx.from.project_members, (s, m) => s.activeProjectId.eq(m.projectId)).build());

export const active_entities = spacetimedb.view({ name: 'active_entities', public: true }, t.array(entities.rowType), ctx =>
  ctx.from.sessions.where(s => s.identity.eq(ctx.sender)).rightSemijoin(ctx.from.entities, (s, e) => s.activeProjectId.eq(e.projectId)).build());

export const active_edit_log = spacetimedb.view({ name: 'active_edit_log', public: true }, t.array(edit_log.rowType), ctx =>
  ctx.from.sessions.where(s => s.identity.eq(ctx.sender)).rightSemijoin(ctx.from.edit_log, (s, e) => s.activeProjectId.eq(e.projectId)).build());

export const active_scenarios = spacetimedb.view({ name: 'active_scenarios', public: true }, t.array(scenarios.rowType), ctx =>
  ctx.from.sessions.where(s => s.identity.eq(ctx.sender)).rightSemijoin(ctx.from.scenarios, (s, e) => s.activeProjectId.eq(e.projectId)).build());

export const active_runs = spacetimedb.view({ name: 'active_runs', public: true }, t.array(sim_runs.rowType), ctx =>
  ctx.from.sessions.where(s => s.identity.eq(ctx.sender)).rightSemijoin(ctx.from.sim_runs, (s, r) => s.activeProjectId.eq(r.projectId)).build());

export const active_replay = spacetimedb.view({ name: 'active_replay', public: true }, t.array(replay_chunks.rowType), ctx =>
  ctx.from.sessions.where(s => s.identity.eq(ctx.sender)).rightSemijoin(ctx.from.replay_chunks, (s, c) => s.activeRunId.eq(c.runId)).build());

export const active_result = spacetimedb.view({ name: 'active_result', public: true }, t.array(sim_results.rowType), ctx =>
  ctx.from.sessions.where(s => s.identity.eq(ctx.sender)).rightSemijoin(ctx.from.sim_results, (s, r) => s.activeRunId.eq(r.runId)).build());

export const active_agent_jobs = spacetimedb.view({ name: 'active_agent_jobs', public: true }, t.array(agent_jobs.rowType), ctx =>
  ctx.from.sessions.where(s => s.identity.eq(ctx.sender)).rightSemijoin(ctx.from.agent_jobs, (s, j) => s.activeProjectId.eq(j.projectId)).build());

export const active_agent_steps = spacetimedb.view({ name: 'active_agent_steps', public: true }, t.array(agent_steps.rowType), ctx =>
  ctx.from.sessions.where(s => s.identity.eq(ctx.sender)).rightSemijoin(ctx.from.agent_steps, (s, a) => s.activeProjectId.eq(a.projectId)).build());

export const active_proposals = spacetimedb.view({ name: 'active_proposals', public: true }, t.array(proposals.rowType), ctx =>
  ctx.from.sessions.where(s => s.identity.eq(ctx.sender)).rightSemijoin(ctx.from.proposals, (s, p) => s.activeProjectId.eq(p.projectId)).build());

/** The frozen layout of the caller's active run, so replays and heatmaps use the geometry the run actually saw. */
export const active_run_layout = spacetimedb.view({ name: 'active_run_layout', public: true }, t.array(layout_snapshots.rowType), ctx => {
  const session = ctx.db.sessions.identity.find(ctx.sender);
  if (!session || !session.activeRunId) return [];
  const run = ctx.db.sim_runs.id.find(session.activeRunId);
  if (!run) return [];
  const snapshot = ctx.db.layout_snapshots.hash.find(run.layoutHash);
  return snapshot ? [snapshot] : [];
});

/** Stored results (metrics + heatmap bundle) of the caller's comparison pair. */
export const active_compare_results = spacetimedb.view({ name: 'active_compare_results', public: true }, t.array(sim_results.rowType), ctx => {
  const pair = ctx.db.session_compare.identity.find(ctx.sender);
  if (!pair) return [];
  const out = [];
  for (const id of [pair.baselineRunId, pair.candidateRunId]) {
    if (!id) continue;
    const run = ctx.db.sim_runs.id.find(id);
    if (!run) continue;
    // Re-check membership at read time: roles can change after open_compare.
    let member = false;
    for (const m of ctx.db.project_members.projectId.filter(run.projectId)) if (m.identity.isEqual(ctx.sender)) member = true;
    const result = member ? ctx.db.sim_results.runId.find(id) : undefined;
    if (result) out.push(result);
  }
  return out;
});

const isMember = (ctx: { sender: Identity; db: { project_members: { projectId: { filter: (id: string) => Iterable<{ identity: Identity }> } } } }, projectId: string) => {
  for (const m of ctx.db.project_members.projectId.filter(projectId)) if (m.identity.isEqual(ctx.sender)) return true;
  return false;
};

/** Saves page details for every project the caller belongs to, computed at read time. */
export const my_project_stats = spacetimedb.view({ name: 'my_project_stats', public: true }, t.array(project_stats.rowType), ctx => {
  const out = [];
  for (const membership of ctx.db.project_members.identity.filter(ctx.sender)) {
    const projectId = membership.projectId;
    let sizeBytes = 0, walls = 0, doors = 0, windows = 0, exits = 0, floors = 0, members = 0;
    for (const e of ctx.db.entities.projectId.filter(projectId)) {
      sizeBytes += e.payload.length + 1;
      if (e.kind === 'wall') walls++;
      else if (e.kind === 'floor') floors++;
      else if (e.kind === 'opening') {
        const kind = (JSON.parse(e.payload) as { openingKind?: string }).openingKind;
        if (kind === 'door') doors++; else if (kind === 'window') windows++; else if (kind === 'exit') exits++;
      }
    }
    for (const _ of ctx.db.project_members.projectId.filter(projectId)) members++;
    let lastEvacuationSeconds = -1, latest = -1n;
    for (const run of ctx.db.sim_runs.projectId.filter(projectId)) {
      if (run.status !== 'complete' || run.agentJobId || run.createdAt.microsSinceUnixEpoch <= latest) continue;
      const result = ctx.db.sim_results.runId.find(run.id);
      if (!result) continue;
      latest = run.createdAt.microsSinceUnixEpoch;
      const seconds = (JSON.parse(result.metrics) as { evacuationTimeSeconds?: number | null }).evacuationTimeSeconds;
      lastEvacuationSeconds = typeof seconds === 'number' ? seconds : -1;
    }
    out.push({ projectId, sizeBytes, walls, doors, windows, exits, floors, members, lastEvacuationSeconds });
  }
  return out;
});

/** Entity rows of the project the caller previews on the saves page (membership re-checked at read time). */
export const preview_entities = spacetimedb.view({ name: 'preview_entities', public: true }, t.array(entities.rowType), ctx => {
  const preview = ctx.db.session_preview.identity.find(ctx.sender);
  if (!preview || !isMember(ctx, preview.projectId)) return [];
  return [...ctx.db.entities.projectId.filter(preview.projectId)];
});

export const active_room_labels = spacetimedb.view({ name: 'active_room_labels', public: true }, t.array(room_labels.rowType), ctx =>
  ctx.from.sessions.where(s => s.identity.eq(ctx.sender)).rightSemijoin(ctx.from.room_labels, (s, l) => s.activeProjectId.eq(l.projectId)).build());

/** The permanent share link of the caller's active project (members only). */
export const active_share_link = spacetimedb.view({ name: 'active_share_link', public: true }, t.array(project_links.rowType), ctx => {
  const session = ctx.db.sessions.identity.find(ctx.sender);
  if (!session?.activeProjectId || !isMember(ctx, session.activeProjectId)) return [];
  const link = ctx.db.project_links.projectId.find(session.activeProjectId);
  return link ? [link] : [];
});

/** Who is online on the caller's active project right now: members whose session has it open. */
/** What the people on the caller's open project are doing (members only). */
export const active_presence_modes = spacetimedb.view({ name: 'active_presence_modes', public: true }, t.array(presence_modes.rowType), ctx => {
  const session = ctx.db.sessions.identity.find(ctx.sender);
  const projectId = session?.activeProjectId;
  if (!projectId || !isMember(ctx, projectId)) return [];
  const out = [];
  for (const m of ctx.db.project_members.projectId.filter(projectId)) {
    const row = ctx.db.presence_modes.identity.find(m.identity);
    if (row && row.projectId === projectId) out.push(row);
  }
  return out;
});

export const active_presence = spacetimedb.view({ name: 'active_presence', public: true }, t.array(online_connections.rowType), ctx => {
  const session = ctx.db.sessions.identity.find(ctx.sender);
  const projectId = session?.activeProjectId;
  if (!projectId || !isMember(ctx, projectId)) return [];
  const out = [];
  for (const m of ctx.db.project_members.projectId.filter(projectId)) {
    const other = ctx.db.sessions.identity.find(m.identity);
    const online = other?.activeProjectId === projectId ? ctx.db.online_connections.identity.find(m.identity) : undefined;
    if (online) out.push(online);
  }
  return out;
});

/** Runner liveness for every client (no project data). Clients treat a runner as online if seen in the last ~20 s. */
export const runner_status = spacetimedb.anonymousView({ name: 'runner_status', public: true }, t.array(runner_heartbeats.rowType), ctx =>
  ctx.from.runner_heartbeats.build());

// ── Views (runner only) ─────────────────────────────────────────────────────

const isService = (ctx: { sender: Identity; db: { service_identities: { identity: { find: (i: Identity) => unknown } } } }) =>
  !!ctx.db.service_identities.identity.find(ctx.sender);

export const runner_queue = spacetimedb.view({ name: 'runner_queue', public: true }, t.array(sim_runs.rowType), ctx => {
  if (!isService(ctx)) return [];
  const mine = ctx.sender.toHexString();
  return [...ctx.db.sim_runs.status.filter('queued'), ...[...ctx.db.sim_runs.status.filter('running')].filter(r => r.claimedBy === mine)];
});

export const runner_agent_queue = spacetimedb.view({ name: 'runner_agent_queue', public: true }, t.array(agent_jobs.rowType), ctx => {
  if (!isService(ctx)) return [];
  const mine = ctx.sender.toHexString();
  return [...ctx.db.agent_jobs.status.filter('queued'), ...[...ctx.db.agent_jobs.status.filter('running')].filter(j => j.claimedBy === mine)];
});

export const runner_label_queue = spacetimedb.view({ name: 'runner_label_queue', public: true }, t.array(label_requests.rowType), ctx => {
  if (!isService(ctx)) return [];
  const mine = ctx.sender.toHexString();
  return [...ctx.db.label_requests.status.filter('queued'), ...[...ctx.db.label_requests.status.filter('running')].filter(r => r.claimedBy === mine)];
});

/** Frozen layouts of every run and agent job this runner has claimed and not finished. */
export const runner_inputs = spacetimedb.view({ name: 'runner_inputs', public: true }, t.array(layout_snapshots.rowType), ctx => {
  if (!isService(ctx)) return [];
  const mine = ctx.sender.toHexString();
  const hashes = new Set<string>();
  for (const r of ctx.db.sim_runs.status.filter('running')) if (r.claimedBy === mine) hashes.add(r.layoutHash);
  for (const j of ctx.db.agent_jobs.status.filter('running')) if (j.claimedBy === mine) hashes.add(j.snapshotHash);
  return [...hashes].map(h => ctx.db.layout_snapshots.hash.find(h)).filter(s => s != null);
});
