/**
 * Multi-user, permission and durability checks against a running SpacetimeDB
 * (spec §12 persistence/security + rendering/replay). Starts a runner in-process.
 *
 *   node packages/client/scripts/e2e-multiuser.ts [ws://127.0.0.1:3010] [egress-backend]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { layoutHash, parseDocument } from '@egress/core';
import { createSpacetimeClient, type EgressClient } from '@egress/client';
import { DbConnection } from '../src/bindings/index.ts';
import { startRunner } from '../../../services/runner/src/main.ts';

const uri = process.argv[2] ?? 'ws://127.0.0.1:3010';
const db = process.argv[3] ?? 'egress-backend';
const doc = parseDocument(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'content', 'scenes', 'one-room.json'), 'utf8')));
const ok = (msg: string) => console.log(`✓ ${msg}`);
const until = async (check: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out: ${what}`);
    await new Promise(r => setTimeout(r, 50));
  }
};
const expectError = async (p: Promise<unknown>, code: string, what: string) => {
  try {
    await p;
  } catch (e) {
    if ((e as { code?: string }).code === code || String(e).includes(code)) return ok(`${what} → ${code}`);
    throw new Error(`${what}: expected ${code}, got ${String(e)}`);
  }
  throw new Error(`${what}: expected ${code}, but it succeeded`);
};
function makeClient(store: { token?: string }): EgressClient {
  return createSpacetimeClient({ uri, db, tokenStore: { get: () => store.token, set: t => { store.token = t; } } });
}

const runner = await startRunner({ uri, db, token: null, log: () => {} });
const tokenA: { token?: string } = {}, tokenB: { token?: string } = {};
const a = makeClient(tokenA), b = makeClient(tokenB);
await until(() => a.status.get() === 'connected' && b.status.get() === 'connected', 10_000, 'connect');
await until(() => a.runner.get().online, 15_000, 'runner heartbeat');
ok(`runner online via heartbeat (model: ${a.runner.get().agentModel})`);

// Isolation: a private project is invisible to another guest.
const projectId = await a.createProject('Multi-user', doc);
await until(() => a.document.get().doc?.walls.length === 4, 10_000, 'A sees its project');
await new Promise(r => setTimeout(r, 300));
if (b.projects.get().some(p => p.id === projectId)) throw new Error('B can see A\'s private project');
await expectError(b.openProject(projectId), 'UNAUTHORIZED', 'B opens A\'s project without an invite');

// Permanent share link (D59): B joins as a viewer; the link stays the same.
const link = await a.shareLink();
if ((await a.shareLink()) !== link) throw new Error('the share link changed between calls');
await expectError(b.joinByLink('x'.repeat(22)), 'NOT_FOUND', 'B joins with a made-up link');
await b.joinByLink(link);
await until(() => b.document.get().doc?.walls.length === 4, 10_000, 'B (viewer) sees the project');
await until(() => b.projects.get().find(p => p.id === projectId)?.role === 'viewer', 10_000, 'B is a viewer');
ok(`share link (${link.length} chars): B joined as a viewer and reads the project`);
await until(() => a.members.get().filter(m => m.online).length === 2, 10_000, 'presence shows both');
ok(`presence: A sees ${a.members.get().filter(m => m.online).length} online, identities ${a.members.get().map(m => m.identity.slice(0, 8)).join(', ')}`);
const floorId = b.document.get().doc!.floors[0].id;
const viewerEdit = await b.edit([{ kind: 'createWallChain', floorId, points: [{ x: 2, y: 2 }, { x: 2, y: 6 }], thicknessM: 0.2, heightM: 2.8, material: 'normal' }]);
if (viewerEdit.ok) throw new Error('viewer edit was accepted');
ok(`viewer edit refused by the server (${viewerEdit.error.code}); optimistic change rolled back: ${b.document.get().doc!.walls.length === 4}`);

// Only owners change roles; the owner promotes B to editor; edits then sync between the two clients.
const bIdentity = b.members.get().find(m => m.me)!.identity;
await expectError(b.setMemberRole(bIdentity, 'owner'), 'UNAUTHORIZED', 'a viewer promotes themself');
const aIdentity = a.members.get().find(m => m.me)!.identity;
await expectError(a.setMemberRole(aIdentity, 'editor'), 'INVALID_INPUT', 'demoting the last owner');
await a.setMemberRole(bIdentity, 'editor');
await until(() => b.projects.get().find(p => p.id === projectId)?.role === 'editor', 10_000, 'B upgraded to editor');
ok('owner promoted B to editor');
const freshLink = await a.resetShareLink();
if (freshLink === link) throw new Error('reset kept the old link');
const c = makeClient({});
await until(() => c.status.get() === 'connected', 10_000, 'C connects');
await expectError(c.joinByLink(link), 'NOT_FOUND', 'C uses the link after it was reset');
await c.joinByLink(freshLink);
await until(() => a.members.get().length === 3, 10_000, 'C joined with the new link');
c.dispose();
await until(() => a.members.get().filter(m => m.online).length === 2, 10_000, 'presence drops when C leaves');
ok('reset link: the old one is refused, the new one works, and presence drops when C disconnects');
const started = Date.now();
const editorEdit = await b.edit([{ kind: 'createWallChain', floorId, points: [{ x: 2, y: 2 }, { x: 2, y: 6 }], thicknessM: 0.2, heightM: 2.8, material: 'glass' }]);
if (!editorEdit.ok) throw new Error(editorEdit.error.message);
await until(() => (a.document.get().doc?.walls.length ?? 0) === 5, 10_000, 'A receives B\'s edit');
ok(`editor edit from B reached A in ${Date.now() - started} ms`);

// Service-only reducers reject ordinary clients.
const raw = await new Promise<DbConnection>((resolve, reject) => {
  DbConnection.builder().withUri(uri).withDatabaseName(db).onConnect(conn => resolve(conn)).onConnectError((_c, e) => reject(e)).build();
});
await expectError(raw.reducers.claimSimulation({ runId: 'anything' }), 'UNAUTHORIZED', 'ordinary client calls claim_simulation');
await expectError(raw.reducers.runnerHeartbeat({ agentModel: 'x', activeRuns: 0, activeJobs: 0, version: 'x' }), 'UNAUTHORIZED', 'ordinary client calls runner_heartbeat');
await expectError(raw.reducers.registerService({ secret: 'wrong' }), 'UNAUTHORIZED', 'register_service with a wrong secret');
raw.disconnect();

// Collaboration (PLAN.md §3 K, D89): presence by mode, one shared live run, and the edit lock.
await a.setMode('simulate');
await b.setMode('edit');
await until(() => a.members.get().find(m => !m.me)?.mode === 'edit' && b.members.get().find(m => !m.me)?.mode === 'simulate', 10_000, 'modes reach the other person');
ok('presence by mode: A sees B editing, B sees A simulating');
const liveId = await a.startRun({
  scenarioVersion: 1, id: 's-live', projectId, name: 'Evacuate', durationSeconds: 300,
  population: { count: 30, distribution: 'uniform', strokes: [], seed: 9 }, goal: { kind: 'evacuate', blockedExitIds: [] },
}, 'x1');
await until(() => ['queued', 'running'].includes(b.runs.get().find(r => r.id === liveId)?.status ?? ''), 10_000, 'B sees the shared run start');
const followB = b.playback(liveId);
await until(() => followB.state.get().liveTick > 0, 20_000, 'B receives live frames');
ok(`shared live run: B follows A's run without starting anything (live edge at tick ${followB.state.get().liveTick})`);
const lockedEdit = await b.edit([{ kind: 'createWallChain', floorId, points: [{ x: 3, y: 2 }, { x: 3, y: 6 }], thicknessM: 0.2, heightM: 2.8, material: 'normal' }]);
if (lockedEdit.ok || lockedEdit.error.code !== 'PROJECT_LOCKED') throw new Error(`B's edit during the run: expected PROJECT_LOCKED, got ${JSON.stringify(lockedEdit)}`);
ok('B\'s client refuses an edit during the run (PROJECT_LOCKED) without touching the document');
const rawB = await new Promise<DbConnection>((resolve, reject) => {
  DbConnection.builder().withUri(uri).withDatabaseName(db).withToken(tokenB.token).onConnect(conn => resolve(conn)).onConnectError((_c, e) => reject(e)).build();
});
const wire = JSON.stringify({ projectId, requestId: 'locked-raw', baseRevision: b.document.get().doc!.revision, commands: [{ kind: 'createWallChain', floorId, points: [{ x: 3, y: 2 }, { x: 3, y: 6 }], thicknessM: 0.2, heightM: 2.8, material: 'normal' }] });
await expectError(rawB.reducers.applyEdit({ request: wire }), 'PROJECT_LOCKED', 'the server refuses a raw apply_edit during the run');
rawB.disconnect();
await expectError(b.startRun({
  scenarioVersion: 1, id: 's-second', projectId, name: 'Evacuate', durationSeconds: 300,
  population: { count: 10, distribution: 'uniform', strokes: [], seed: 1 }, goal: { kind: 'evacuate', blockedExitIds: [] },
}, 'x4'), 'PROJECT_LOCKED', 'a second run while one is live');
await b.cancelRun(liveId);
await until(() => a.runs.get().find(r => r.id === liveId)?.status === 'cancelled', 10_000, 'A sees B stop the run');
const unlocked = await b.edit([{ kind: 'createWallChain', floorId, points: [{ x: 3, y: 2 }, { x: 3, y: 6 }], thicknessM: 0.2, heightM: 2.8, material: 'normal' }]);
if (!unlocked.ok) throw new Error(`edit after the run was stopped: ${unlocked.error.message}`);
await until(() => (a.document.get().doc?.walls.length ?? 0) > 5, 10_000, 'A receives B\'s edit after the unlock');
ok('B stopped the shared run; editing unlocked for both');
await b.undo();
await until(() => b.document.get().pending === 0 && (a.document.get().doc?.walls.length ?? 0) === 5, 10_000, 'undo of the unlock check');

// Run, then edit the layout, then reconnect: replay survives and uses the run's frozen layout.
const runLayout = layoutHash(a.document.get().doc!);
const runId = await a.startRun({
  scenarioVersion: 1, id: 's-mu', projectId, name: 'Evacuate', durationSeconds: 300,
  population: { count: 30, distribution: 'uniform', strokes: [], seed: 5 }, goal: { kind: 'evacuate', blockedExitIds: [] },
}, 'unpaced');
await until(() => a.runs.get().find(r => r.id === runId)?.status === 'complete', 60_000, 'run complete');
await a.edit([{ kind: 'createWallChain', floorId, points: [{ x: 7, y: 5 }, { x: 9, y: 5 }], thicknessM: 0.2, heightM: 2.8, material: 'normal' }]);
await until(() => a.document.get().pending === 0, 10_000, 'post-run edit confirmed');
a.dispose();

const a2 = makeClient(tokenA); // same identity, fresh connection ("browser refresh")
await until(() => a2.status.get() === 'connected', 10_000, 'reconnect');
await until(() => a2.projects.get().some(p => p.id === projectId), 10_000, 'project list after refresh');
await a2.openProject(projectId);
await until(() => a2.runs.get().some(r => r.id === runId), 10_000, 'run list after refresh');
const playback = a2.playback(runId);
await until(() => playback.state.get().complete, 30_000, 'replay reloaded');
playback.seek(playback.state.get().liveTick);
const field = playback.field('people.congestion', 'timeAverage');
if (!field) throw new Error('no heatmap on replay');
const layoutNow = layoutHash(a2.document.get().doc!);
ok(`replay survives refresh: ${playback.state.get().liveTick} ticks, heatmap ${field.grid.width}×${field.grid.height}; run layout ${runLayout.slice(0, 8)} ≠ current ${layoutNow.slice(0, 8)}: ${runLayout !== layoutNow}`);

a2.dispose();
b.dispose();
runner.stop();
console.log('MULTI-USER E2E OK');
process.exit(0);
