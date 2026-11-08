import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseDocument, type EgressDocument, type SimulationScenario } from '@egress/core';
import { floorAirflow, runSimulation } from '@egress/sim';

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

test('an HVAC supply vent pushes air toward an open exit, and a sealed room stays still', () => {
  const doc = load('scenes/one-room.json'), floorId = doc.floors[0].id;
  const vent = [{ position: { x: 5, y: 7 }, radiusM: 0.6 }];
  const open = floorAirflow(doc, floorId, 'north', vent);
  const g = open.magnitude.grid, at = (x: number, y: number) => Math.floor((y - g.origin.y) / g.cellSizeM) * g.width + Math.floor((x - g.origin.x) / g.cellSizeM);
  const mid = at(5, 4);
  assert.ok(open.y[mid] < 0, 'air in the middle of the room flows south, from the vent toward the exit');
  const sealed = floorAirflow({ ...doc, openings: doc.openings.map(o => ({ ...o, state: 'closed' as const })) }, floorId, 'north', vent);
  assert.equal(sealed.peak, 0);
});
