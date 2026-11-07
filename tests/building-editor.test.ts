import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editBuilding, editorReducer, initialEditor, openingAt, snapPoint, wallEnd, wallSections } from '../lib/building-editor.ts';
import type { Building } from '../lib/floorplan.ts';

const base: Building = { width: 20, depth: 15, sourceWidth: 800, sourceHeight: 600, walls: [{ id: 'wall-1', x1: -4, z1: 0, x2: 4, z2: 0, thickness: .2 }] };

test('wall building snaps to the grid and existing vertices, with optional angled placement', () => {
  assert.deepEqual(snapPoint({ x: 3.9, z: .08 }, base.walls), { x: 4, z: 0 });
  assert.deepEqual(snapPoint({ x: 1.24, z: 2.3 }, []), { x: 1, z: 2.5 });
  assert.deepEqual(wallEnd({ x: 0, z: 0 }, { x: 3, z: 2 }, []), { x: 3, z: 0 });
  assert.deepEqual(wallEnd({ x: 0, z: 0 }, { x: 3, z: 2 }, [], true), { x: 3, z: 2 });
});

test('wall creation is immutable and rejects zero length and duplicate segments', () => {
  const result = editBuilding(base, { type: 'wall', start: { x: 4, z: 0 }, end: { x: 4, z: 4 } });
  assert.ok(editBuilding(base, { type: 'wall', start: { x: 0, z: 0 }, end: { x: 6, z: 0 } }).error);
  assert.equal(result.building.walls.length, 2); assert.equal(base.walls.length, 1);
  assert.ok(editBuilding(base, { type: 'wall', start: { x: 0, z: 0 }, end: { x: 0, z: 0 } }).error);
  assert.ok(editBuilding(base, { type: 'wall', start: { x: 4, z: 0 }, end: { x: -4, z: 0 } }).error);
});

test('door/window openings attach to walls, clamp to their ends, and reject overlaps', () => {
  const door = editBuilding(base, { type: 'opening', wallId: 'wall-1', kind: 'door', point: { x: 0, z: 0 } }).building;
  assert.equal(door.walls[0].openings?.[0].offset, 4);
  assert.ok(editBuilding(door, { type: 'opening', wallId: 'wall-1', kind: 'window', point: { x: .1, z: 0 } }).error);
  const window = openingAt(base.walls[0], 'window', { x: 50, z: 0 }).opening!;
  assert.ok(window.offset + window.width / 2 <= 7.9 + .00001);
});

test('wall sections leave real door and window holes rather than overlaying objects', () => {
  const door = editBuilding(base, { type: 'opening', wallId: 'wall-1', kind: 'door', point: { x: -2, z: 0 } }).building;
  const window = editBuilding(door, { type: 'opening', wallId: 'wall-1', kind: 'window', point: { x: 2, z: 0 } }).building;
  const pieces = wallSections(window.walls[0], 2.8);
  const solidArea = pieces.reduce((sum, p) => sum + p.width * p.height, 0);
  assert.ok(Math.abs(solidArea - (8 * 2.8 - .9 * 2.1 - 1.2 * 1.2)) < .0001);
  assert.ok(pieces.some(p => p.bottom === 0 && Math.abs(p.height - .9) < .001));
});

test('deleting an opening restores its wall; undo/redo restores the same semantic objects', () => {
  let state = editorReducer(initialEditor, { type: 'load', building: base });
  state = editorReducer(state, { type: 'edit', command: { type: 'opening', wallId: 'wall-1', kind: 'door', point: { x: 0, z: 0 } } });
  const id = state.present!.walls[0].openings![0].id;
  state = editorReducer(state, { type: 'edit', command: { type: 'delete', wallId: 'wall-1', openingId: id } });
  assert.equal(state.present!.walls[0].openings!.length, 0);
  state = editorReducer(state, { type: 'undo' }); assert.equal(state.present!.walls[0].openings![0].id, id);
  state = editorReducer(state, { type: 'redo' }); assert.equal(state.present!.walls[0].openings!.length, 0);
  state = editorReducer(state, { type: 'edit', command: { type: 'delete', wallId: 'wall-1' } });
  assert.equal(state.present!.walls.length, 0);
  state = editorReducer(state, { type: 'undo' }); assert.equal(state.present!.walls.length, 1);
});

test('distant wall placement never grows or moves the original floor', () => {
  const loaded = editorReducer(initialEditor, { type: 'load', building: base });
  const originalFloor = loaded.present!.floorBounds;
  let state = editorReducer(loaded, { type: 'edit', command: { type: 'wall', start: { x: 80, z: 90 }, end: { x: 85, z: 90 } } });
  assert.deepEqual(state.present!.floorBounds, originalFloor);
  assert.equal(state.present!.walls.length, 2);
  state = editorReducer(state, { type: 'undo' }); assert.deepEqual(state.present!.floorBounds, originalFloor);
  state = editorReducer(state, { type: 'redo' }); assert.deepEqual(state.present!.floorBounds, originalFloor);
  state = editorReducer(state, { type: 'edit', command: { type: 'delete-walls', wallIds: state.present!.walls.map(w => w.id) } });
  assert.equal(state.present!.walls.length, 0);
  assert.deepEqual(state.present!.floorBounds, originalFloor);
});

test('bulk deletion removes attached doors/windows and undoes as one edit', () => {
  let state = editorReducer(initialEditor, { type: 'load', building: base });
  state = editorReducer(state, { type: 'edit', command: { type: 'opening', wallId: 'wall-1', kind: 'door', point: { x: 0, z: 0 } } });
  state = editorReducer(state, { type: 'edit', command: { type: 'wall', start: { x: 4, z: 0 }, end: { x: 4, z: 5 } } });
  const before = state.present;
  state = editorReducer(state, { type: 'edit', command: { type: 'delete-walls', wallIds: state.present!.walls.map(w => w.id) } });
  assert.equal(state.present!.walls.length, 0);
  state = editorReducer(state, { type: 'undo' });
  assert.deepEqual(state.present, before);
  assert.equal(state.present!.walls[0].openings!.length, 1);
});

test('history starts empty and invalid edits do not create an undo step', () => {
  const loaded = editorReducer(initialEditor, { type: 'load', building: base });
  assert.equal(loaded.past.length, 0); assert.equal(loaded.future.length, 0);
  const state = editorReducer(loaded, { type: 'edit', command: { type: 'wall', start: { x: 0, z: 0 }, end: { x: 0, z: 0 } } });
  assert.equal(state.past.length, 0); assert.equal(state.future.length, 0);
});
