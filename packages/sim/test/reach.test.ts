import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parseDocument } from '@egress/core';
import { exitReach, isSpawnable, compileFloor } from '@egress/sim';

const content = join(import.meta.dirname, '..', '..', '..', 'content');
const load = (path: string) => parseDocument(JSON.parse(readFileSync(join(content, path), 'utf8')));

test('the whole crowd is shared between exits, and clear time is people over door flow', () => {
  const reach = exitReach(load('scenes/hall.json'), 500);
  assert.equal(reach.exits.length, 2);
  assert.ok(Math.abs(reach.exits.reduce((s, e) => s + e.people, 0) - 500) < 1e-6);
  for (const e of reach.exits) assert.ok(Math.abs(e.clearSeconds - e.people / e.capacity) < 1e-9);
});

test('the slowest exit is decided by door width, not floor area', () => {
  const reach = exitReach(load('scenes/hall.json'), 500);
  const [wide, narrow] = [...reach.exits].sort((a, b) => b.capacity - a.capacity);
  assert.ok(wide.people > narrow.people, 'the wide door has the larger area');
  assert.equal(narrow.slowest, true);
  assert.equal(wide.slowest, false);
});

test('every spawnable cell is assigned to an exit', () => {
  const doc = load('scenes/hall.json'), reach = exitReach(doc, 100);
  const floorId = doc.floors[0].id, c = compileFloor(doc, floorId), { cells } = reach.floors[floorId];
  for (let i = 0; i < cells.length; i++) if (isSpawnable(c, i)) assert.ok(cells[i] >= 0);
});

test('upper floors reach an exit through the stairs, and their people count there', () => {
  const doc = load('examples/clinic.json'), reach = exitReach(doc, 80);
  assert.ok(Math.abs(reach.exits.reduce((s, e) => s + e.people, 0) - 80) < 1e-6);
  const upper = [...doc.floors].sort((a, b) => b.level - a.level)[0];
  assert.ok(Array.from(reach.floors[upper.id].cells).some(e => e >= 0));
});

test('painting a crowd near one exit moves the load there', () => {
  const doc = load('scenes/hall.json'), even = exitReach(doc, 100), target = even.exits[0];
  const stroke = { floorId: doc.floors[0].id, points: [{ x: target.center.x, y: target.center.y }], radiusM: 8, mode: 'increase' as const, weight: 3, falloff: 'flat' as const };
  const painted = exitReach(doc, 100, [stroke as never]);
  assert.ok(painted.exits[0].people > target.people);
});

test('a single exit is never called the slowest', () => {
  assert.equal(exitReach(load('scenes/one-room.json'), 50).exits[0].slowest, false);
});
