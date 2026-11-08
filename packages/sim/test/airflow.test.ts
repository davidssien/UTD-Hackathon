import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEditOrThrow, emptyDocument } from '@egress/core';
import { compileFloor, floorAirflow } from '@egress/sim';

function crossVentilation() {
  const floorId = 'ground';
  let doc = applyEditOrThrow(emptyDocument('wind', floorId), { requestId: 'shell', commands: [
    { kind: 'createBox', floorId, min: { x: 0, y: 0 }, max: { x: 10, y: 4 }, thicknessM: 0.2, heightM: 3, material: 'normal' },
  ] }).doc;
  const points = new Map(doc.vertices.map(v => [v.id, v.position]));
  const wallAt = (x: number) => doc.walls.find(w => points.get(w.startVertexId)!.x === x && points.get(w.endVertexId)!.x === x)!;
  doc = applyEditOrThrow(doc, { requestId: 'apertures', commands: [
    { kind: 'createOpening', wallId: wallAt(0).id, openingKind: 'window', offsetM: 2, widthM: 1.5, state: 'open' },
    { kind: 'createOpening', wallId: wallAt(10).id, openingKind: 'exit', offsetM: 2, widthM: 1.5, state: 'open' },
  ] }).doc;
  return { doc, floorId };
}

test('open exterior windows carry air without becoming walkable exits, and wind reversal reverses velocity', () => {
  const { doc, floorId } = crossVentilation();
  const west = floorAirflow(doc, floorId, 'west'), east = floorAirflow(doc, floorId, 'east');
  const compiled = compileFloor(doc, floorId), mid = compiled.nav.cellAt(5, 2);
  assert.equal(compiled.exits.length, 1);
  assert.equal(west.exteriorOpenings, 2);
  assert.ok(west.x[mid] > 0.08);
  assert.ok(Math.abs(west.y[mid]) < 0.01);
  assert.ok(west.magnitude.values.some(Number.isNaN));
  assert.deepEqual(west.magnitude.values, east.magnitude.values);
  assert.equal(west.x[mid], -east.x[mid]);
  assert.equal(floorAirflow(doc, floorId, 'north').peak, 0);
});

test('sealed, single-opening and disconnected rooms have exactly zero through-flow', () => {
  const { doc, floorId } = crossVentilation();
  for (const openings of [[], doc.openings.slice(0, 1), doc.openings.map(o => o.openingKind === 'window' ? { ...o, state: 'closed' as const } : o)]) {
    assert.equal(floorAirflow({ ...doc, openings }, floorId).peak, 0);
  }
  const divided = applyEditOrThrow(doc, { requestId: 'partition', commands: [
    { kind: 'createWallChain', floorId, points: [{ x: 5, y: 0 }, { x: 5, y: 4 }], thicknessM: 0.2, heightM: 3, material: 'normal' },
  ] }).doc;
  assert.equal(floorAirflow(divided, floorId).peak, 0);
  const wallId = divided.walls.find(w => {
    const ends = [w.startVertexId, w.endVertexId].map(id => divided.vertices.find(v => v.id === id)!.position);
    return ends.every(p => p.x === 5);
  })!.id;
  const connected = applyEditOrThrow(divided, { requestId: 'door', commands: [
    { kind: 'createOpening', wallId, openingKind: 'door', widthM: 1, offsetM: 2, state: 'open' },
  ] }).doc;
  assert.ok(floorAirflow(connected, floorId).peak > 0.1);
});

test('wind can come from any compass bearing: 270° is west, and in-between bearings blend the sides', () => {
  const { doc, floorId } = crossVentilation(); // apertures on the west and east walls
  const close = (a: Float32Array, b: Float32Array) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
  const west = floorAirflow(doc, floorId, 'west'), bearing = floorAirflow(doc, floorId, 270);
  assert.ok(close(west.x, bearing.x) && close(west.y, bearing.y), '270° matches west');
  const mid = compileFloor(doc, floorId).nav.cellAt(5, 2);
  // Only the east-west component drives this room: sin(240°) of the westerly strength, reversed for 60°.
  const wsw = floorAirflow(doc, floorId, 240), ene = floorAirflow(doc, floorId, 60);
  assert.ok(Math.abs(wsw.x[mid] / (west.x[mid] * Math.sin((240 * Math.PI) / 180) / Math.sin((270 * Math.PI) / 180)) - 1) < 1e-5, 'scales with the east-west component');
  assert.ok(Math.abs(ene.x[mid] + wsw.x[mid]) < 1e-6, 'opposite bearings reverse the flow');
});

