import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseDocument, type ActorFrame, type SimulationScenario } from '@egress/core';
import { cannedRun, createMockClient, Playback, type PlaybackClock } from '@egress/client';

const fixture = (name: string) =>
  parseDocument(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'content', 'scenes', name), 'utf8')));

const scenario = (projectId: string, count = 50): SimulationScenario => ({
  scenarioVersion: 1, id: 's1', projectId, name: 'Evacuate', durationSeconds: 120,
  population: { count, distribution: 'uniform', strokes: [], seed: 7 }, goal: { kind: 'evacuate', blockedExitIds: [] },
});

function fakeClock() {
  let now = 0;
  const clock: PlaybackClock = { now: () => now, setInterval: () => 1, clearInterval: () => {} };
  return { clock, advance: (ms: number) => { now += ms; } };
}

const frame = (tick: number, x: number): ActorFrame => ({ tick, actorXY: new Float32Array([x, 0]), actorFlags: new Uint8Array([0]) });

test('playback follows the LIVE edge, skips ±10 s, interpolates, and stops at END', () => {
  const { clock, advance } = fakeClock();
  const p = new Playback('r', clock);
  p.setStatus('running');
  p.pushFrames(Array.from({ length: 200 }, (_, t) => frame(t, t / 10)));
  assert.equal(p.state.get().liveTick, 199);

  p.play();
  advance(1000); p.tickClock();
  assert.ok(Math.abs(p.state.get().tick - 10) < 1e-9, 'one second of wall time = 10 ticks at 1×');

  p.skip(10);
  assert.ok(Math.abs(p.state.get().tick - 110) < 1e-9);
  p.skip(-30);
  assert.equal(p.state.get().tick, 0, 'clamped at 0');

  p.seek(55.5);
  const a = p.actorsNow()!;
  assert.ok(Math.abs(a.actorXY[0] - 5.55) < 1e-5, 'interpolates between frames');

  p.seek(1000);
  assert.equal(p.state.get().tick, 199, 'clamped at the LIVE edge');
  assert.equal(p.state.get().atLiveEdge, true);
  advance(1000); p.tickClock();
  assert.equal(p.state.get().playing, true, 'keeps waiting at the live edge while the run is still going');

  p.pushFrames(Array.from({ length: 20 }, (_, i) => frame(200 + i, 20 + i / 10)));
  p.setStatus('complete');
  assert.equal(p.state.get().complete, true);
  advance(5000); p.tickClock();
  assert.equal(p.state.get().tick, 219);
  assert.equal(p.state.get().playing, false, 'stops at END');
});

test('mock client edits, undoes and redoes with real applyEdit', async () => {
  const client = createMockClient();
  const floorId = client.document.get().doc!.floors[0].id;
  const r = await client.edit([{ kind: 'createBox', floorId, min: { x: 0, y: 0 }, max: { x: 6, y: 4 }, thicknessM: 0.2, heightM: 2.8, material: 'normal' }]);
  assert.equal(r.ok, true);
  assert.equal(client.document.get().doc!.walls.length, 4);
  await client.undo();
  assert.equal(client.document.get().doc!.walls.length, 0);
  assert.equal(client.document.get().canRedo, true);
  await client.redo();
  assert.equal(client.document.get().doc!.walls.length, 4);
  const bad = await client.edit([{ kind: 'deleteEntities', ids: ['nope'] }]);
  assert.equal(bad.ok, false);
  assert.equal(client.document.get().lastError?.code, 'NOT_FOUND');
  client.dispose();
});

test('canned run evacuates everyone through the one-room exit and reports metrics', () => {
  const doc = fixture('one-room.json');
  const { frames, metrics } = cannedRun(doc, scenario(doc.projectId, 80), 'r');
  assert.equal(metrics.evacuatedPeople, 80);
  assert.ok(metrics.maxQueueLength > 0, 'a 0.9 m exit should queue 80 people');
  assert.equal(frames[0].actorFlags.length, 80);
  frames.forEach((f, i) => assert.equal(f.tick, i));
});

test('mock unpaced run streams chunks into playback until complete', async () => {
  const client = createMockClient({ seed: [{ name: 'One room', doc: fixture('one-room.json') }] });
  const projectId = client.document.get().projectId!;
  const runId = await client.startRun(scenario(projectId, 30), 'unpaced');
  const playback = client.playback(runId);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(playback.state.get().complete, true);
  assert.equal(playback.metrics.get()?.evacuatedPeople, 30);
  assert.equal(client.runs.get()[0].status, 'complete');
  client.dispose();
});

test('mock agent proposes a valid edit whose ghost ids match acceptance', async () => {
  const client = createMockClient({ seed: [{ name: 'One room', doc: fixture('one-room.json') }] });
  await client.askAgent('Find the bottleneck');
  await new Promise(resolve => setTimeout(resolve, 1400));
  const [proposal] = client.proposals.get();
  assert.ok(proposal?.ghost, 'proposal has a ghost preview');
  await client.acceptProposal(proposal.id);
  const exit = client.document.get().doc!.openings.find(o => o.openingKind === 'exit')!;
  assert.ok(Math.abs(exit.widthM - 1.5) < 1e-9);
  assert.equal(client.proposals.get()[0].status, 'accepted');
  client.dispose();
});
