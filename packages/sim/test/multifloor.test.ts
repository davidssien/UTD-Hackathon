import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  ACTOR_EXITED, ACTOR_TRANSITIONING, applyEditOrThrow, decodeChunk, emptyDocument, encodeChunk,
  floorsByLevel, parseDocument, type EgressDocument, type SimulationScenario,
} from '@egress/core';
import { initialize, simulateChunks, type InitialActors } from '@egress/sim';

function simulate(doc: EgressDocument, count: number, initialActors?: InitialActors, blockedExitIds: string[] = []) {
  const scenario: SimulationScenario = {
    id: 'evacuate', projectId: doc.projectId, scenarioVersion: 1, name: 'Evacuate', durationSeconds: 180,
    population: { count, seed: 1, distribution: 'uniform', strokes: [] }, goal: { kind: 'evacuate', blockedExitIds },
  };
  const state = initialize({ runId: 'test', document: doc, scenario, initialActors });
  const chunks = [...simulateChunks(state)];
  return { state, frames: chunks.flatMap(c => c.frames), chunks, metrics: chunks.at(-1)!.metrics };
}

function hillside() {
  let doc = emptyDocument('hill', 'ground');
  doc = applyEditOrThrow(doc, { requestId: 'up', commands: [{ kind: 'createFloor', name: 'Upper' }] }).doc;
  const floors = floorsByLevel(doc), low = floors[0].id, high = floors[1].id;
  const polygon = [{ x: 0, y: 0 }, { x: 24, y: 0 }, { x: 24, y: 7 }, { x: 0, y: 7 }];
  for (const f of floors) {
    doc = applyEditOrThrow(doc, { requestId: f.id + '.box', commands: [
      { kind: 'createBox', floorId: f.id, min: polygon[0], max: polygon[2], thicknessM: 0.2, heightM: 2.8, material: 'normal' },
      { kind: 'createSlab', floorId: f.id, polygon, material: 'basic' },
    ] }).doc;
    const v = new Map(doc.vertices.map(v => [v.id, v.position]));
    const south = doc.walls.find(w => w.floorId === f.id && v.get(w.startVertexId)!.y === 0 && v.get(w.endVertexId)!.y === 0)!;
    doc = applyEditOrThrow(doc, { requestId: f.id + '.door', commands: [{ kind: 'createOpening', wallId: south.id,
      openingKind: 'exit', widthM: 1.2, offsetM: Math.abs(v.get(south.startVertexId)!.x - (f.id === low ? 3 : 22)) }] }).doc;
  }
  doc = applyEditOrThrow(doc, { requestId: 'stair', commands: [{ kind: 'createStair', floorId: low,
    min: { x: 2, y: 1 }, max: { x: 4, y: 6 }, upEdge: 'n' }] }).doc;
  const initial: InitialActors = { x: [3, 22], y: [6.5, 1], r: [0.23, 0.23], vPref: [1.3, 1.3], floorIds: [high, high] };
  return { doc, initial, low, high };
}

test('hillside occupants choose between the upper exit and the full route down the stairs', () => {
  const { doc, initial } = hillside();
  const run = simulate(doc, 2, initial);
  assert.equal(run.state.respawned, 0);
  assert.equal(run.metrics.evacuatedPeople, 2);
  assert.equal(run.metrics.unreachablePeople, 0);
  assert.deepEqual(Object.values(run.metrics.perExitThroughput).sort(), [1, 1]);
  const descent = run.frames.filter(f => f.actorFlags[0] === ACTOR_TRANSITIONING);
  assert.ok(descent.length > 20);
  assert.ok(descent[0].actorElevation![0] > descent.at(-1)!.actorElevation![0]);
  assert.ok(descent.every((f, i) => !i || f.actorElevation![0] <= descent[i - 1].actorElevation![0]));
  assert.ok(run.frames.every(f => f.actorFloor![1] === 1));
  assert.deepEqual([...run.frames.at(-1)!.actorFloor!], [0, 1]);
  const repeat = simulate(doc, 2, initial);
  for (let i = 0; i < run.chunks.length; i++) {
    const bytes = encodeChunk(run.chunks[i], run.state.compiled.grid.origin);
    assert.deepEqual(bytes, encodeChunk(repeat.chunks[i], repeat.state.compiled.grid.origin));
    const frame = decodeChunk(bytes).frames[0], expected = run.chunks[i].frames[0];
    assert.deepEqual(frame.actorFloor, expected.actorFloor);
    assert.ok(Math.abs(frame.actorElevation![0] - expected.actorElevation![0]) <= 0.0051);
  }
});

test('an unavailable onward exit makes its stair ineligible, and a disconnected occupied floor is counted', () => {
  const { doc, initial, low } = hillside();
  const blocked = doc.openings.filter(o => o.floorId === low).map(o => o.id);
  const run = simulate(doc, 2, initial, blocked);
  assert.equal(run.metrics.evacuatedPeople, 2);
  assert.ok(run.frames.every(f => !f.actorFlags.includes(ACTOR_TRANSITIONING)));
  const isolated = simulate({ ...doc, stairs: [], openings: doc.openings.filter(o => o.floorId === low) }, 2, initial);
  assert.equal(isolated.metrics.unreachablePeople, 2);
  assert.equal(isolated.metrics.evacuatedPeople, 0);
  assert.equal(isolated.metrics.remainingPeople, 2);
});

test('two-story clinic evacuates its seeded upstairs crowd through the stair', () => {
  const doc = parseDocument(JSON.parse(readFileSync(new URL('../../../content/examples/clinic.json', import.meta.url), 'utf8')));
  const run = simulate(doc, 80);
  const upstairs = [...run.frames[0].actorFloor!].flatMap((f, i) => f === 1 ? [i] : []);
  assert.ok(upstairs.length > 20);
  for (const a of upstairs) assert.ok(run.frames.some(f => f.actorFlags[a] === ACTOR_TRANSITIONING));
  assert.equal(run.metrics.evacuatedPeople, 80);
  assert.ok(run.frames.at(-1)!.actorFlags.every(f => f === ACTOR_EXITED));
});


test('a third-floor occupant follows two successive flights to a ground-floor exit', () => {
  const base = hillside();
  let doc = applyEditOrThrow(base.doc, { requestId: 'third', commands: [{ kind: 'createFloor', name: 'Top' }] }).doc;
  const upper = floorsByLevel(doc)[2].id;
  const polygon = [{ x: 0, y: 0 }, { x: 24, y: 0 }, { x: 24, y: 7 }, { x: 0, y: 7 }];
  doc = applyEditOrThrow(doc, { requestId: 'extend', commands: [
    { kind: 'createBox', floorId: upper, min: polygon[0], max: polygon[2], thicknessM: 0.2, heightM: 2.8, material: 'normal' },
    { kind: 'createSlab', floorId: upper, polygon, material: 'basic' },
    { kind: 'createStair', floorId: base.high, min: { x: 8, y: 1 }, max: { x: 10, y: 6 }, upEdge: 's' },
  ] }).doc;
  const run = simulate(doc, 1, { floorIds: [upper], x: [9], y: [0.65], r: [0.23], vPref: [1.3] },
    doc.openings.filter(o => o.floorId === base.high).map(o => o.id));
  assert.equal(run.metrics.perFloor![upper].stairDescents, 1);
  assert.equal(run.metrics.perFloor![base.high].stairDescents, 1);
  assert.equal(run.metrics.perFloor![base.low].exitedHere, 1);
  assert.deepEqual([...new Set(run.frames.map(f => f.actorFloor![0]))], [2, 1, 0]);
});
