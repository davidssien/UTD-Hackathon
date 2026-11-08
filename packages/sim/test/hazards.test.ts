import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyEditOrThrow, parseDocument, type EgressDocument, type SimulationScenario } from '@egress/core';
import { advanceHazard, compileFloor, createHazards, floorAirflow, runSimulation } from '@egress/sim';
import { solveAir } from '../src/airflow.ts';

const root = join(import.meta.dirname, '..', '..', '..', 'content');
const load = (path: string) => parseDocument(JSON.parse(readFileSync(join(root, path), 'utf8')));
const run = (doc: EgressDocument, people: number, elements?: SimulationScenario['elements']) => runSimulation({
  runId: 'hz', document: doc,
  scenario: {
    scenarioVersion: 1, id: 'hz', projectId: doc.projectId, name: 'Fire', durationSeconds: 600,
    population: { count: people, distribution: 'uniform', strokes: [], seed: 3 }, goal: { kind: 'evacuate', blockedExitIds: [] }, elements,
  },
}, { keepChunks: false }).metrics;

test('a fire by the main exit sends the crowd to the other exits and around the flames', () => {
  const doc = load('examples/event-hall.json'), floorId = doc.floors[0].id;
  const base = run(doc, 500);
  const fire = run(doc, 500, [{ kind: 'fire', id: 'f', floorId, position: { x: 3, y: 12 }, radiusM: 1, startSeconds: 0 }]);
  const main = Object.entries(base.perExitThroughput).sort((a, b) => b[1] - a[1])[0][0];
  assert.ok(fire.perExitThroughput[main] < base.perExitThroughput[main] / 10, `main exit ${base.perExitThroughput[main]} → ${fire.perExitThroughput[main]}`);
  assert.equal(fire.evacuatedPeople + fire.fireDeaths! + fire.smokeDeaths! + fire.unreachablePeople, 500, 'everyone is accounted for');
  assert.ok(fire.fireDeaths! <= 10, `only people who started in the flames are lost (${fire.fireDeaths})`);
  assert.ok(fire.evacuationTimeSeconds! > base.evacuationTimeSeconds!, 'losing the main exit costs time');
  assert.equal(base.fireDeaths, undefined, 'no hazard, no fatality fields');
});

test('people trapped behind a fire at the only exit are overcome by smoke, and the run ends', () => {
  const doc = load('scenes/one-room.json'), floorId = doc.floors[0].id;
  const m = run(doc, 30, [{ kind: 'fire', id: 'f', floorId, position: { x: 5, y: 1.2 }, radiusM: 0.5, startSeconds: 0 }]);
  assert.ok(m.smokeDeaths! > 0, `smoke deaths ${m.smokeDeaths}`);
  assert.equal(m.evacuatedPeople + m.fireDeaths! + m.smokeDeaths! + m.unreachablePeople, 30, `accounted (${m.endReason})`);
  assert.ok(m.complete);
});

test('placeables: a table stops people but not air; a ceiling vent drives air to the exit; a sealed room stays still', () => {
  const room = load('scenes/one-room.json'), floorId = room.floors[0].id;
  const doc = applyEditOrThrow(room, { requestId: 'p', commands: [
    { kind: 'createPlaceable', floorId, item: 'table', position: { x: 5, y: 4 }, rotationDeg: 90 },
    { kind: 'createPlaceable', floorId, item: 'vent', position: { x: 5, y: 7 } },
  ] }).doc;
  const people = compileFloor(doc, floorId), g = people.grid;
  const at = (x: number, y: number) => Math.floor((y - g.origin.y) / g.cellSizeM) * g.width + Math.floor((x - g.origin.x) / g.cellSizeM);
  assert.equal(people.navigable[at(5, 4.6)], 0, 'people cannot stand on the (rotated) table');
  const air = floorAirflow(doc, floorId, 'north');
  const ga = air.magnitude.grid, cell = Math.floor((4.6 - ga.origin.y) / ga.cellSizeM) * ga.width + Math.floor((5 - ga.origin.x) / ga.cellSizeM);
  assert.ok(Number.isFinite(air.magnitude.values[cell]) && air.y[cell] < 0, 'air passes over the table, south from the vent toward the exit');
  const sealed = floorAirflow({ ...doc, openings: doc.openings.map(o => ({ ...o, state: 'closed' as const })) }, floorId, 'north');
  assert.equal(sealed.peak, 0);
});

test('lassoed fire areas burn per floor and spread by seeded chance', () => {
  const doc = load('examples/clinic.json');
  const [ground, upper] = [...doc.floors].sort((a, b) => a.level - b.level);
  const square = (x: number, y: number) => [{ x, y }, { x: x + 2, y }, { x: x + 2, y: y + 2 }, { x, y: y + 2 }];
  const elements: SimulationScenario['elements'] = [
    { kind: 'fireArea', id: 'a', floorId: ground.id, polygon: square(2, 2), startSeconds: 0 },
    { kind: 'fireArea', id: 'b', floorId: upper.id, polygon: square(15, 2), startSeconds: 5 },
  ];
  const burn = (seed: number) => { const hs = createHazards(doc, { elements, seed }); for (const h of hs) advanceHazard(h, 600); return hs; };
  const [a, b, c] = [burn(1), burn(1), burn(2)];
  assert.deepEqual(a.map(h => h.floorId), [ground.id, upper.id]);
  assert.ok(a.every(h => h.burningCount > 64), `each area burns and spreads (${a.map(h => h.burningCount)})`);
  assert.deepEqual(a.map(h => h.burningCount), b.map(h => h.burningCount), 'same seed, same fire');
  assert.notDeepEqual(a.map(h => [...h.burning].join('')), c.map(h => [...h.burning].join('')), 'another seed spreads differently');
});

test('burning cells push air like a supply vent: a stagnant room flows out of its exit', () => {
  const doc = load('scenes/one-room.json'), floorId = doc.floors[0].id;
  const still = solveAir(doc, floorId, 'north');
  assert.equal(still.peak, 0, 'one aperture and no sources: no through-flow');
  const burning = new Uint8Array(still.navigable.length), g = still.grid;
  const at = (x: number, y: number) => Math.floor((y - g.origin.y) / g.cellSizeM) * g.width + Math.floor((x - g.origin.x) / g.cellSizeM);
  for (let x = 4; x <= 6; x += 0.25) for (let y = 6.5; y <= 7.5; y += 0.25) burning[at(x, y)] = 1;
  const fire = solveAir(doc, floorId, 'north', [], { burning });
  assert.ok(fire.y[at(5, 4)] < 0, 'air in the middle of the room moves south, away from the fire toward the exit');
});
