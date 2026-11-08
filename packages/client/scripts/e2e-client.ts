/**
 * End-to-end check of SpacetimeEgressClient against a running SpacetimeDB
 * (default local :3010), with the runner started in-process.
 *
 *   node packages/client/scripts/e2e-client.ts [ws://127.0.0.1:3010] [egress-dev]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from '@egress/core';
import { createSpacetimeClient } from '@egress/client';
import { startRunner } from '../../../services/runner/src/main.ts';

const uri = process.argv[2] ?? 'ws://127.0.0.1:3010';
const db = process.argv[3] ?? 'egress-local';
const doc = parseDocument(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'content', 'scenes', 'one-room.json'), 'utf8')));
const ok = (msg: string) => console.log(`✓ ${msg}`);
const until = async (check: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out: ${what}`);
    await new Promise(r => setTimeout(r, 50));
  }
};

const runner = await startRunner({ uri, db, token: null, log: () => {} });
let token: string | undefined;
const client = createSpacetimeClient({ uri, db, tokenStore: { get: () => token, set: t => { token = t; } } });

await until(() => client.status.get() === 'connected', 10_000, 'connect');
const projectId = await client.createProject('Client E2E', doc);
await until(() => client.document.get().doc?.walls.length === 4, 10_000, 'seeded document');
ok(`project ${projectId} open with ${client.document.get().doc!.walls.length} walls`);

const floorId = client.document.get().doc!.floors[0].id;
const edit = await client.edit([{ kind: 'createWallChain', floorId, points: [{ x: 3, y: 8 }, { x: 3, y: 5 }], thicknessM: 0.2, heightM: 2.8, material: 'normal' }]);
if (!edit.ok) throw new Error(edit.error.message);
await until(() => client.document.get().pending === 0 && client.document.get().doc!.revision === 1, 10_000, 'edit confirmed');
ok(`optimistic edit confirmed by the server (revision ${client.document.get().doc!.revision}, ${client.document.get().doc!.walls.length} walls)`);

const bad = await client.edit([{ kind: 'deleteEntities', ids: ['nope'] }]);
ok(`invalid edit rejected locally: ${!bad.ok && bad.error.code}`);

await client.undo();
await until(() => client.document.get().pending === 0 && client.document.get().doc!.walls.length === 4, 10_000, 'undo confirmed');
ok('undo round-trips through the server');

const runId = await client.startRun({
  scenarioVersion: 1, id: 's-client', projectId, name: 'Evacuate', durationSeconds: 300,
  population: { count: 50, distribution: 'uniform', strokes: [], seed: 2 }, goal: { kind: 'evacuate', blockedExitIds: [] },
}, 'unpaced');
const playback = client.playback(runId);
await until(() => playback.state.get().complete && !!playback.metrics.get()?.complete, 60_000, 'run complete in playback');
playback.seek(playback.state.get().liveTick);
const heat = playback.field('people.congestion', 'timeAverage');
ok(`run streamed to playback: ${playback.state.get().liveTick} ticks, evacuated ${playback.metrics.get()!.evacuatedPeople}/50, heatmap cells ${heat?.values.length}`);

const jobId = await client.askAgent('Find the bottleneck', { runId });
await until(() => client.agentJobs.get().some(j => j.id === jobId && (j.status === 'complete' || j.status === 'failed')), 120_000, 'agent job');
const proposal = client.proposals.get().find(p => p.jobId === jobId);
ok(`agent ${client.agentJobs.get().find(j => j.id === jobId)!.status}, ${client.agentSteps.get().filter(s => s.jobId === jobId).length} steps, proposal ghost: ${!!proposal?.ghost}`);
if (proposal) {
  const rev = client.document.get().doc!.revision;
  await client.acceptProposal(proposal.id);
  await until(() => client.document.get().doc!.revision === rev + 1, 10_000, 'proposal applied');
  ok('proposal accepted and applied');
}

client.dispose();
runner.stop();
console.log('CLIENT E2E OK');
process.exit(0);
