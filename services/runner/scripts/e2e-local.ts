/**
 * End-to-end check against a running SpacetimeDB (default: local, port 3010).
 * Starts the runner in-process with a fresh identity, then acts as a user:
 * project → session-scoped views → edit → simulation (replay chunks + result)
 * → agent job → accept proposal.
 *
 *   spacetimedb-cli start --listen-addr 127.0.0.1:3010
^ *   npm run login:local -w @egress/spacetimedb && npm run publish:local -w @egress/spacetimedb
 *   node services/runner/scripts/e2e-local.ts [ws://127.0.0.1:3010] [egress-dev]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, decodeChunk, decodeFieldBundle, parseDocument } from '@egress/core';
import { tables } from '../../../packages/client/src/bindings/index.ts';
import { startRunner } from '../src/main.ts';
import { connect, until } from '../src/spacetime.ts';

const uri = process.argv[2] ?? 'ws://127.0.0.1:3010';
const db = process.argv[3] ?? 'egress-local';
const doc = parseDocument(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'content', 'scenes', 'two-rooms-corridor.json'), 'utf8')));
const tag = Date.now().toString(36);
const step = (msg: string) => console.log(`✓ ${msg}`);

const runner = await startRunner({ uri, db, token: null, log: line => console.log(`  ${line}`) });
step(`runner registered as ${runner.identity.slice(0, 12)}…`);

const { conn } = await connect({ uri, db });
await new Promise<void>((resolve, reject) => {
  conn.subscriptionBuilder().onApplied(() => resolve()).onError(() => reject(new Error('user subscription failed'))).subscribe([
    tables.mySession, tables.myProjects, tables.activeEntities, tables.activeEditLog, tables.activeRuns, tables.activeReplay,
    tables.activeResult, tables.activeAgentJobs, tables.activeAgentSteps, tables.activeProposals,
  ]);
});
const entities = () => [...conn.db.activeEntities.iter()];

const p1 = `e2e-${tag}-a`, p2 = `e2e-${tag}-b`;
const expected = doc.floors.length + doc.vertices.length + doc.walls.length + doc.openings.length;
await conn.reducers.createProject({ projectId: p1, name: 'E2E two rooms', seedDocument: canonicalJson(doc) });
await until(() => entities().length === expected, 10_000, 'seeded entities');
step(`project ${p1} created; active_entities shows ${expected} rows`);

await conn.reducers.createProject({ projectId: p2, name: 'E2E empty', seedDocument: '' });
await until(() => entities().length === 1, 10_000, 'view to follow the session to the empty project');
await conn.reducers.openProject({ projectId: p1 });
await until(() => entities().length === expected, 10_000, 'view to follow the session back');
step('session-scoped views re-evaluate when the session row changes (spike a)');

const requestId = `req-${tag}`;
await conn.reducers.applyEdit({ request: canonicalJson({ projectId: p1, requestId, baseRevision: 0, commands: [
  { kind: 'createBox', floorId: doc.floors[0].id, min: { x: 18, y: 0 }, max: { x: 22, y: 4 }, thicknessM: 0.2, heightM: 2.8, material: 'normal' },
] }) });
await until(() => [...conn.db.activeEditLog.iter()].some(r => r.requestId === requestId), 10_000, 'edit log entry');
step(`apply_edit committed (${entities().length} entities, edit log has the request id)`);

const runId = `run-${tag}`;
await conn.reducers.requestSimulation({ runId, pace: 'unpaced', scenario: canonicalJson({
  scenarioVersion: 1, id: `s-${tag}`, projectId: p1, name: 'Evacuate', durationSeconds: 300,
  population: { count: 80, distribution: 'uniform', strokes: [], seed: 3 }, goal: { kind: 'evacuate', blockedExitIds: [] },
}) });
const result = await until(() => [...conn.db.activeResult.iter()].find(r => r.runId === runId), 60_000, 'simulation result');
const chunks = [...conn.db.activeReplay.iter()].filter(c => c.runId === runId).sort((a, b) => a.chunkIndex - b.chunkIndex);
const first = decodeChunk(chunks[0].bytes);
const metrics = JSON.parse(result.metrics);
const fields = decodeFieldBundle(result.fields);
step(`simulation: ${chunks.length} replay chunks (bytes are ${chunks[0].bytes.constructor.name}, spike c), ` +
  `${first.frames[0].actorFlags.length} actors, evacuated ${metrics.evacuatedPeople} in ${metrics.evacuationTimeSeconds} s, ` +
  `${Object.keys(fields.fields).length} result fields`);

const jobId = `job-${tag}`;
await conn.reducers.requestAgentJob({ jobId, projectId: p1, prompt: 'Investigate the worst bottleneck', context: canonicalJson({ runId }) });
const job = await until(() => [...conn.db.activeAgentJobs.iter()].find(j => j.id === jobId && j.status !== 'queued' && j.status !== 'running'), 120_000, 'agent job');
const steps = [...conn.db.activeAgentSteps.iter()].filter(s => s.jobId === jobId).sort((a, b) => a.seq - b.seq);
step(`agent ${job.status}: ${steps.filter(s => s.kind === 'tool_call').map(s => s.toolName).join(' → ')}`);
console.log(`  ${job.summary}`);

const proposal = [...conn.db.activeProposals.iter()].find(p => p.jobId === jobId);
if (proposal) {
  const before = entities().length;
  await conn.reducers.acceptProposal({ proposalId: proposal.id });
  await until(() => [...conn.db.activeProposals.iter()].find(p => p.id === proposal.id)?.status === 'accepted', 10_000, 'accepted proposal');
  step(`proposal accepted (${before} → ${entities().length} entities)`);
} else {
  console.log('  (no proposal this time)');
}

runner.stop();
conn.disconnect();
console.log('E2E OK');
process.exit(0);
