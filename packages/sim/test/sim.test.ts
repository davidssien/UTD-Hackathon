import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ACTOR_EXITED, applyEditOrThrow, parseDocument, sha256Hex, type EgressDocument, type SimulationScenario,
} from '@egress/core';
import { compileFloor, initialize, isComplete, metrics, runSimulation, step } from '@egress/sim';

const fixture = (name: string) => parseDocument(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'content', 'scenes', name), 'utf8')));
const scenario = (doc: EgressDocument, count: number, seed = 1, blockedExitIds: string[] = []): SimulationScenario => ({
  scenarioVersion: 1, id: 's', projectId: doc.projectId, name: 'Evacuate', durationSeconds: 600,
  population: { count, distribution: 'uniform', strokes: [], seed }, goal: { kind: 'evacuate', blockedExitIds },
});

test('nobody is ever inside a wall (3 seeds, every tick)', () => {
  const doc = fixture('two-rooms-corridor.json');
  for (const seed of [1, 2, 3]) {
    const s = initialize({ runId: 'r', document: doc, scenario: scenario(doc, 80, seed) });
    while (!isComplete(s)) {
      step(s);
      for (let a = 0; a < s.n; a++) {
        if (s.flag[a] === ACTOR_EXITED) continue;
        assert.ok(!s.compiled.segments.insideSolid(s.x[a], s.y[a]), `seed ${seed} tick ${s.tick}: actor ${a} inside a wall`);
      }
    }
  }
});

test('everyone leaves through 0.9 m doors and a 1.2 m exit, and a queue forms', () => {
  const doc = fixture('two-rooms-corridor.json');
  const { metrics: m } = runSimulation({ runId: 'r', document: doc, scenario: scenario(doc, 120) }, { keepChunks: false });
  assert.equal(m.evacuatedPeople, 120);
  assert.equal(m.complete, true);
  assert.ok(m.evacuationTimeSeconds! > 30 && m.evacuationTimeSeconds! < 200, `evacuation took ${m.evacuationTimeSeconds} s`);
  assert.ok(m.maxQueueLength >= 3, 'people queue at the bottleneck');
  assert.equal(Object.values(m.perExitThroughput).reduce((a, b) => a + b, 0), 120);
});

test('same seed ⇒ identical frames; different seed ⇒ different frames', () => {
  const doc = fixture('one-room.json');
  const hash = (seed: number) => {
    const { chunks } = runSimulation({ runId: 'r', document: doc, scenario: scenario(doc, 40, seed) });
    const parts = chunks.flatMap(c => c.frames.map(f => `${f.tick}:${Array.from(f.actorXY).join(',')}:${Array.from(f.actorFlags).join('')}`));
    return sha256Hex(parts.join('|'));
  };
  assert.equal(hash(5), hash(5));
  assert.notEqual(hash(5), hash(6));
});

test('blocking the main exit sends everyone to the narrow one and slows the evacuation', () => {
  const doc = fixture('hall.json');
  const exits = compileFloor(doc).exits;
  const main = exits.find(e => e.widthM === 2)!, narrow = exits.find(e => e.widthM === 0.9)!;
  const open = runSimulation({ runId: 'a', document: doc, scenario: scenario(doc, 150) }, { keepChunks: false }).metrics;
  const blocked = runSimulation({ runId: 'b', document: doc, scenario: scenario(doc, 150, 1, [main.openingId]) }, { keepChunks: false }).metrics;
  assert.equal(blocked.perExitThroughput[main.openingId], 0);
  assert.equal(blocked.perExitThroughput[narrow.openingId], 150);
  assert.ok(blocked.evacuationTimeSeconds! > open.evacuationTimeSeconds!, `${blocked.evacuationTimeSeconds} > ${open.evacuationTimeSeconds}`);
});

test('people in a sealed room are reported unreachable and the run still completes', () => {
  let doc = fixture('hall.json');
  doc = applyEditOrThrow(doc, { requestId: 'seal', commands: [
    { kind: 'createBox', floorId: doc.floors[0].id, min: { x: 4, y: 14 }, max: { x: 9, y: 18 }, thicknessM: 0.2, heightM: 2.8, material: 'normal' },
  ] }).doc;
  const { metrics: m } = runSimulation({ runId: 'r', document: doc, scenario: scenario(doc, 200, 4) }, { keepChunks: false });
  assert.ok(m.unreachablePeople > 0, 'some people start inside the sealed box');
  assert.equal(m.evacuatedPeople + m.unreachablePeople, 200);
  assert.equal(m.complete, true);
});

test('too many people for the floor area is an explicit error, not silent deletion', () => {
  const doc = fixture('one-room.json');
  assert.throws(() => initialize({ runId: 'r', document: doc, scenario: scenario(doc, 500) }), (e: Error & { code?: string }) => e.code === 'POPULATION_INFEASIBLE');
});

test('the congestion heatmap survives the end of the evacuation and peaks at the bottleneck', () => {
  const doc = fixture('one-room.json');
  const { state, metrics: m } = runSimulation({ runId: 'r', document: doc, scenario: scenario(doc, 80) }, { keepChunks: false });
  const avg = state.fields.field('people.congestion', 'timeAverage')!;
  const instant = state.fields.field('people.density', 'instant')!;
  const max = (v: Float32Array) => v.reduce((acc, x) => (Number.isFinite(x) && x > acc ? x : acc), 0);
  assert.equal(max(instant.values), 0, 'building is empty at the end');
  assert.ok(max(avg.values) > 0.5, 'time-averaged congestion remains');
  const top = m.bottlenecks[0];
  assert.ok(Math.hypot(top.regionCenter.x - 5, top.regionCenter.y - 0) < 2.5, `worst hotspot near the exit, got ${JSON.stringify(top.regionCenter)}`);
  assert.equal(metrics(state).complete, true);
});

test('structural route demand converges on doors and the exit; exit distance grows away from it', async () => {
  const { structuralField } = await import('@egress/sim');
  const doc = fixture('two-rooms-corridor.json');
  const c = compileFloor(doc);
  const demand = structuralField(c, 'people.routeDemand');
  const dist = structuralField(c, 'people.exitDistance');
  let maxI = 0;
  demand.values.forEach((v, i) => { if (v > demand.values[maxI] || !(demand.values[maxI] >= 0)) maxI = i; });
  const cx = maxI % c.grid.width, cy = (maxI - cx) / c.grid.width;
  const p = { x: c.grid.origin.x + (cx + 0.5) * 0.25, y: c.grid.origin.y + (cy + 0.5) * 0.25 };
  assert.ok(Math.hypot(p.x - 0, p.y - 1) < 1, `peak demand at the exit, got ${JSON.stringify(p)}`);
  const roomCell = demand.values[c.nav.cellAt(4, 8)];
  assert.ok(demand.values[maxI] > 50 * roomCell, `exit demand ${demand.values[maxI]} dwarfs a room cell ${roomCell}`);
  const far = dist.values[c.nav.cellAt(15, 11)], near = dist.values[c.nav.cellAt(1, 1)];
  assert.ok(far > 20 && near < 2, `far ${far}, near ${near}`);
});
