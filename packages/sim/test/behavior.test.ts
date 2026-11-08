import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEdit, emptyDocument, type EgressDocument, type SimulationScenario } from '@egress/core';
import { initialize, metrics, step, endReason, MODEL_VERSION } from '@egress/sim';

/** A 16 × 10 m hall with two 0.9 m exits on the south wall: the classic flip-flop setup. */
function twoExitHall(): EgressDocument {
  let doc = emptyDocument('behavior');
  const floorId = doc.floors[0].id;
  const box = applyEdit(doc, { requestId: 'b', commands: [{ kind: 'createBox', floorId, min: { x: 0, y: 0 }, max: { x: 16, y: 10 }, thicknessM: 0.2, heightM: 2.8, material: 'normal' }] });
  assert.ok(box.ok); doc = box.doc;
  const vertices = new Map(doc.vertices.map(v => [v.id, v.position]));
  const south = doc.walls.find(w => vertices.get(w.startVertexId)!.y === 0 && vertices.get(w.endVertexId)!.y === 0)!;
  const start = vertices.get(south.startVertexId)!;
  const offset = (x: number) => Math.abs(x - start.x);
  const exits = applyEdit(doc, {
    requestId: 'e', commands: [4, 12].map(x => ({ kind: 'createOpening' as const, wallId: south.id, openingKind: 'exit' as const, offsetM: offset(x), widthM: 0.9 })),
  });
  assert.ok(exits.ok); return exits.doc;
}

const scenario = (seed: number, count: number): SimulationScenario => ({
  scenarioVersion: 1, id: 's', projectId: 'behavior', name: 'Evacuate', durationSeconds: 600,
  population: { count, distribution: 'uniform', strokes: [], seed }, goal: { kind: 'evacuate', blockedExitIds: [] },
});

test('v0.2 exit choice: people commit to exits instead of flip-flopping, and both exits share the load (D79)', () => {
  assert.equal(MODEL_VERSION, '0.2.0');
  const doc = twoExitHall();
  for (const seed of [1, 2, 3]) {
    const state = initialize({ runId: 'r', document: doc, scenario: scenario(seed, 200) });
    // v0.1 moved 20–40 people in a single tick (the shimmy); v0.2 staggers decisions by attention span.
    let burst = 0, prev = Int32Array.from(state.exit);
    while (!endReason(state)) {
      step(state);
      let changed = 0;
      for (let a = 0; a < state.n; a++) if (state.exit[a] !== prev[a]) changed++;
      burst = Math.max(burst, changed); prev = Int32Array.from(state.exit);
    }
    const m = metrics(state);
    assert.equal(m.endReason, 'all-out', `seed ${seed}: everyone gets out`);
    assert.ok(burst <= 3, `seed ${seed}: at most 3 people switch in the same tick (got ${burst})`);
    assert.ok((m.exitReversals ?? 0) <= 200 * 0.05, `seed ${seed}: reversals ${m.exitReversals} of 200 people`);
    const [a, b] = Object.values(m.perExitThroughput);
    assert.ok(Math.abs(a - b) <= 200 * 0.2, `seed ${seed}: exits share the load (${a} vs ${b})`);
  }
});

test('behaviour traits are seeded: same seed, same switches; positions unchanged by the traits stream', () => {
  const doc = twoExitHall();
  const run = () => { const s = initialize({ runId: 'r', document: doc, scenario: scenario(7, 150) }); while (!endReason(s)) step(s); return metrics(s); };
  const a = run(), b = run();
  assert.equal(a.exitSwitches, b.exitSwitches);
  assert.equal(a.evacuationTimeSeconds, b.evacuationTimeSeconds);
});
