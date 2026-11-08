import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseDocument, type ActorFrame, type SimulationScenario } from '@egress/core';
import { createMockClient, Playback, type PlaybackClock } from '@egress/client';

const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
};

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

test('saves page API: stats, preview, rename, JSON round trip and delete (mock)', async () => {
  const client = createMockClient({ seed: [{ name: 'Hall', doc: fixture('hall.json') }] });
  const id = client.projects.get()[0].id;
  const stats = client.projectStats.get().find(s => s.projectId === id)!;
  const doc = await client.previewProject(id);
  assert.equal(stats.walls, doc.walls.length);
  assert.equal(stats.exits, doc.openings.filter(o => o.openingKind === 'exit').length);
  assert.ok(stats.sizeBytes > 500, `size is counted (${stats.sizeBytes} B)`);
  assert.equal(stats.lastEvacuationSeconds, null, 'no run yet');

  await client.renameProject(id, '  Main hall ');
  assert.equal(client.projects.get().find(p => p.id === id)!.name, 'Main hall');
  await assert.rejects(client.renameProject(id, ''), /1–80/);

  const copy = await client.importProject('Copy of hall', JSON.stringify(doc));
  const imported = await client.previewProject(copy);
  assert.equal(imported.walls.length, doc.walls.length, 'download then import round-trips the walls');
  assert.equal(client.projectStats.get().find(s => s.projectId === copy)!.sizeBytes > 0, true);
  await assert.rejects(client.importProject('Bad', '{"not":"a project"}'), /./);

  await client.deleteProject(copy);
  assert.equal(client.projects.get().some(p => p.id === copy), false);
  assert.equal(client.projectStats.get().some(s => s.projectId === copy), false);
});

test('LIVE stays lit while following a streaming run, trails the edge, and drops on scrub-back (D82)', () => {
  const { clock, advance } = fakeClock();
  const p = new Playback('r', clock);
  p.setStatus('running');
  p.pushFrames(Array.from({ length: 40 }, (_, t) => frame(t, t / 10)));
  p.goLive();
  assert.equal(p.state.get().tick, 39 - 20, 'follow mode starts one chunk behind the edge');
  assert.equal(p.state.get().atLiveEdge, true);
  // The server sends a 2 s chunk every 2 s of wall time while playback runs at 1×.
  for (let chunk = 0; chunk < 10; chunk++) {
    for (let i = 0; i < 4; i++) { advance(500); p.tickClock(); assert.equal(p.state.get().atLiveEdge, true, `lit between chunks (chunk ${chunk})`); }
    const from = p.state.get().liveTick + 1;
    p.pushFrames(Array.from({ length: 20 }, (_, i) => frame(from + i, (from + i) / 10)));
    assert.equal(p.state.get().atLiveEdge, true, 'lit when a chunk lands');
  }
  assert.ok(p.state.get().liveTick - p.state.get().tick >= 10, 'still trailing, never stalled at the edge');
  p.skip(-10);
  assert.equal(p.state.get().atLiveEdge, false, 'scrubbing back leaves LIVE at once');
  p.goLive();
  assert.equal(p.state.get().atLiveEdge, true);
  p.pause();
  // goLive trails by 2 s; 1.5 s more while paused is 3.5 s behind, still lit.
  p.pushFrames(Array.from({ length: 15 }, (_, i) => frame(p.state.get().liveTick + 1 + i, 0)));
  assert.equal(p.state.get().atLiveEdge, true, 'paused 3.5 s behind: still within the debounce');
  p.pushFrames(Array.from({ length: 10 }, (_, i) => frame(p.state.get().liveTick + 1 + i, 0)));
  assert.equal(p.state.get().atLiveEdge, false, 'more than 4 s behind: off');
});

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

test('mock runs the real simulation, streams chunks into playback, and computes heatmaps from frames', async () => {
  const client = createMockClient({ seed: [{ name: 'One room', doc: fixture('one-room.json') }] });
  const projectId = client.document.get().projectId!;
  const runId = await client.startRun(scenario(projectId, 40), 'unpaced');
  const playback = client.playback(runId);
  await until(() => playback.state.get().complete);
  assert.equal(playback.state.get().complete, true);
  const m = playback.metrics.get()!;
  assert.equal(m.evacuatedPeople, 40);
  assert.ok(m.maxQueueLength > 0, 'a 0.9 m exit should queue 40 people');
  assert.equal(client.runs.get()[0].status, 'complete');
  playback.seek(playback.state.get().liveTick);
  const avg = playback.field('people.congestion', 'timeAverage')!;
  assert.ok(avg.values.some(v => v > 0.1), 'time-averaged congestion is visible after everyone left');
  playback.seek(100);
  assert.ok(playback.field('people.density', 'instant')!.values.some(v => v > 0), 'scrubbing back recomputes the heatmap');
  client.dispose();
});

test('an impossible head count fails the run with POPULATION_INFEASIBLE', async () => {
  const client = createMockClient({ seed: [{ name: 'One room', doc: fixture('one-room.json') }] });
  const runId = await client.startRun(scenario(client.document.get().projectId!, 600), 'unpaced');
  const run = client.runs.get().find(r => r.id === runId)!;
  assert.equal(run.status, 'failed');
  assert.equal(run.error?.code, 'POPULATION_INFEASIBLE');
  client.dispose();
});

test('mock agent runs real tools and simulations, and Accept applies exactly the ghosted edit', async () => {
  const client = createMockClient({ seed: [{ name: 'Two rooms', doc: fixture('two-rooms-corridor.json') }] });
  const projectId = client.document.get().projectId!;
  const runId = await client.startRun(scenario(projectId, 80), 'unpaced');
  await until(() => client.playback(runId).state.get().complete);
  const jobId = await client.askAgent('Investigate the worst bottleneck', { runId });
  await until(() => client.agentJobs.get().find(j => j.id === jobId)?.status !== 'running', 30000);
  const steps = client.agentSteps.get().filter(s => s.jobId === jobId);
  assert.ok(steps.some(s => s.kind === 'tool_call' && s.toolName === 'test_edit_batch'), 'tested candidates');
  assert.ok(client.runs.get().some(r => r.agentJobId === jobId), 'agent runs are listed');
  const [proposal] = client.proposals.get();
  assert.ok(proposal?.ghost, 'proposal has a ghost preview');
  assert.ok(proposal.delta.evacuationTimeSeconds < 0, JSON.stringify(proposal.delta));
  const before = client.document.get().doc!.revision;
  await client.acceptProposal(proposal.id);
  const after = client.document.get().doc!;
  assert.equal(after.revision, before + 1);
  for (const id of proposal.ghost!.createdIds.flat()) assert.ok([...after.openings, ...after.walls, ...after.vertices].some(e => e.id === id), 'same ids as the ghost');
  assert.equal(client.proposals.get()[0].status, 'accepted');
  client.dispose();
});

test('compareRuns returns measured deltas and a congestion difference map for an agent proposal', async () => {
  const client = createMockClient({ seed: [{ name: 'Two rooms', doc: fixture('two-rooms-corridor.json') }] });
  const runId = await client.startRun(scenario(client.document.get().projectId!, 80), 'unpaced');
  await until(() => client.playback(runId).state.get().complete);
  const jobId = await client.askAgent('Investigate', { runId });
  await until(() => client.agentJobs.get().find(j => j.id === jobId)?.status !== 'running', 30000);
  const proposal = client.proposals.get()[0];
  const cmp = await client.compareRuns(proposal.baselineRunId, proposal.candidateRunId);
  assert.ok(cmp.delta.evacuationTimeSeconds < 0, JSON.stringify(cmp.delta));
  assert.ok(cmp.congestionDiff, 'difference map present');
  const finite = Array.from(cmp.congestionDiff!.values).filter(Number.isFinite);
  assert.ok(Math.min(...finite) < -0.1, 'some cells got less congested');
  client.dispose();
});
