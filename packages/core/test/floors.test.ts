import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEdit, applyEditOrThrow, emptyDocument, parseDocument, type EgressDocument } from '@egress/core';

const base = () => emptyDocument('p1', 'f0');
const square = [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 4 }, { x: 0, y: 4 }];

const twoFloors = () => applyEditOrThrow(base(), { requestId: 'up', commands: [{ kind: 'createFloor', name: 'First floor' }] }).doc;

test('documents without slabs or stairs still parse (D74)', () => {
  const { slabs: _s, stairs: _t, ...legacy } = base();
  const doc = parseDocument(legacy);
  assert.deepEqual(doc.slabs, []);
  assert.deepEqual(doc.stairs, []);
});

test('createSlab adds a surface; updateSlab changes its finish; undo removes it', () => {
  const made = applyEditOrThrow(base(), { requestId: 's', commands: [{ kind: 'createSlab', floorId: 'f0', polygon: square, material: 'wood' }] });
  assert.equal(made.doc.slabs.length, 1);
  assert.equal(made.doc.slabs[0].id, 's.0');
  const tiled = applyEditOrThrow(made.doc, { requestId: 't', commands: [{ kind: 'updateSlab', slabId: 's.0', patch: { material: 'tile' } }] });
  assert.equal(tiled.doc.slabs[0].material, 'tile');
  const undone = applyEditOrThrow(made.doc, { requestId: 'u', commands: [made.inverse] });
  assert.equal(undone.doc.slabs.length, 0);
});

test('a slab too small to stand on is rejected', () => {
  const r = applyEdit(base(), { requestId: 's', commands: [{ kind: 'createSlab', floorId: 'f0', polygon: [{ x: 0, y: 0 }, { x: 0.2, y: 0 }, { x: 0, y: 0.2 }], material: 'basic' }] });
  assert.equal(r.ok, false);
});

test('createFloor stacks on the top floor; updateFloor height moves the floors above (D75)', () => {
  let doc: EgressDocument = twoFloors();
  doc = applyEditOrThrow(doc, { requestId: 'up2', commands: [{ kind: 'createFloor', name: 'Second floor', ceilingHeightM: 4 }] }).doc;
  const byLevel = [...doc.floors].sort((a, b) => a.level - b.level);
  assert.deepEqual(byLevel.map(f => [f.level, f.elevationM]), [[0, 0], [1, 3], [2, 6]]);
  doc = applyEditOrThrow(doc, { requestId: 'h', commands: [{ kind: 'updateFloor', floorId: 'f0', patch: { ceilingHeightM: 4.5, name: 'Lobby' } }] }).doc;
  const after = [...doc.floors].sort((a, b) => a.level - b.level);
  assert.equal(after[0].name, 'Lobby');
  assert.deepEqual(after.map(f => f.elevationM), [0, 4.5, 7.5]);
});

test('createStair needs a floor above and connects to it', () => {
  const none = applyEdit(base(), { requestId: 'st', commands: [{ kind: 'createStair', floorId: 'f0', min: { x: 0, y: 0 }, max: { x: 1.2, y: 4 }, upEdge: 'n' }] });
  assert.equal(none.ok, false);
  const doc = twoFloors();
  const r = applyEditOrThrow(doc, { requestId: 'st', commands: [{ kind: 'createStair', floorId: 'f0', min: { x: 1.2, y: 4 }, max: { x: 0, y: 0 }, upEdge: 'n' }] });
  const stair = r.doc.stairs[0];
  assert.equal(stair.toFloorId, 'up.0');
  assert.deepEqual([stair.min, stair.max], [{ x: 0, y: 0 }, { x: 1.2, y: 4 }], 'corners are normalized');
  const turned = applyEditOrThrow(r.doc, { requestId: 'tu', commands: [{ kind: 'updateStair', stairId: stair.id, patch: { upEdge: 'e' } }] });
  assert.equal(turned.doc.stairs[0].upEdge, 'e');
  const thin = applyEdit(doc, { requestId: 'x', commands: [{ kind: 'createStair', floorId: 'f0', min: { x: 0, y: 0 }, max: { x: 0.5, y: 4 }, upEdge: 'n' }] });
  assert.equal(thin.ok, false, 'stairs are at least 0.8 m wide');
});

test('deleting a floor removes its contents and stairs, and lowers the floors above', () => {
  let doc = twoFloors();
  doc = applyEditOrThrow(doc, { requestId: 'up2', commands: [{ kind: 'createFloor', name: 'Second floor' }] }).doc;
  doc = applyEditOrThrow(doc, {
    requestId: 'fill', commands: [
      { kind: 'createSlab', floorId: 'up.0', polygon: square, material: 'wood' },
      { kind: 'createStair', floorId: 'f0', min: { x: 0, y: 0 }, max: { x: 1.2, y: 4 }, upEdge: 'n' },
      { kind: 'createStair', floorId: 'up.0', min: { x: 0, y: 0 }, max: { x: 1.2, y: 4 }, upEdge: 'n' },
    ],
  }).doc;
  const r = applyEditOrThrow(doc, { requestId: 'del', commands: [{ kind: 'deleteEntities', ids: ['up.0'] }] });
  assert.equal(r.doc.floors.length, 2);
  assert.equal(r.doc.slabs.length, 0);
  assert.equal(r.doc.stairs.length, 0, 'both stairs touched the deleted floor');
  const top = r.doc.floors.find(f => f.id === 'up2.0')!;
  assert.deepEqual([top.level, top.elevationM], [1, 3]);
  const back = applyEditOrThrow(r.doc, { requestId: 'undo', commands: [r.inverse] });
  assert.equal(back.doc.stairs.length, 2);
  assert.equal(back.doc.floors.find(f => f.id === 'up2.0')!.level, 2);
});

test('the last floor cannot be deleted', () => {
  const r = applyEdit(base(), { requestId: 'd', commands: [{ kind: 'deleteEntities', ids: ['f0'] }] });
  assert.equal(r.ok, false);
});
