import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyEditOrThrow, parseDocument } from '@egress/core';
import { compileFloor, floorAirflow, runSimulation } from '@egress/sim';

const root = join(import.meta.dirname, '..', '..', '..', 'content');
const load = (path: string) => parseDocument(JSON.parse(readFileSync(join(root, path), 'utf8')));

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

test('a room of furniture still evacuates: people walk around tables and chairs', () => {
  const room = load('scenes/one-room.json'), floorId = room.floors[0].id;
  const commands = [2.5, 5, 7.5].flatMap(x => [
    { kind: 'createPlaceable' as const, floorId, item: 'table' as const, position: { x, y: 5 } },
    { kind: 'createPlaceable' as const, floorId, item: 'chair' as const, position: { x, y: 4.2 } },
  ]);
  const doc = applyEditOrThrow(room, { requestId: 'f', commands }).doc;
  const m = runSimulation({ runId: 'f', document: doc, scenario: {
    scenarioVersion: 1, id: 'f', projectId: doc.projectId, name: 'Evacuate', durationSeconds: 300,
    population: { count: 40, distribution: 'uniform', strokes: [], seed: 2 }, goal: { kind: 'evacuate', blockedExitIds: [] },
  } }, { keepChunks: false }).metrics;
  assert.equal(m.evacuatedPeople, 40);
  assert.equal(m.unreachablePeople, 0);
});
