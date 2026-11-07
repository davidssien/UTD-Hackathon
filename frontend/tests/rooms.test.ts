import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enclosedRooms, polygonArea, roomAt } from '../lib/rooms.ts';
import { editBuilding, editorReducer, initialEditor } from '../lib/building-editor.ts';
import type { Wall, Building } from '../lib/floorplan.ts';

const wall = (x1: number, z1: number, x2: number, z2: number, id = crypto.randomUUID()): Wall => ({ id, x1, z1, x2, z2, thickness: .2 });
const rectangle = () => [wall(0, 0, 6, 0), wall(6, 0, 6, 4), wall(6, 4, 0, 4), wall(0, 4, 0, 0)];
const model = (walls: Wall[]): Building => ({ walls, width: 20, depth: 15, sourceWidth: 800, sourceHeight: 600 });

test('fills a closed rectangular room but rejects exterior points and open boundaries', () => {
  const walls = rectangle();
  assert.equal(enclosedRooms(walls).length, 1);
  assert.equal(polygonArea(roomAt(walls, { x: 2, z: 2 })!), 24);
  assert.equal(roomAt(walls, { x: 12, z: 2 }), undefined);
  assert.equal(roomAt(walls.slice(0, 3), { x: 2, z: 2 }), undefined);
});

test('splits rooms at T junctions and ignores door/window voids in their shared wall', () => {
  const walls = [...rectangle(), { ...wall(3, 0, 3, 4), openings: [{ id: 'door', type: 'door' as const, offset: 2, width: .9, height: 2.1, sill: 0 }] }];
  assert.equal(enclosedRooms(walls).length, 2);
  assert.equal(polygonArea(roomAt(walls, { x: 1, z: 2 })!), 12);
  assert.equal(polygonArea(roomAt(walls, { x: 5, z: 2 })!), 12);
});

test('handles concave and angled room outlines without filling the missing corner', () => {
  const outline = [[0,0],[4,0],[4,2],[2,2],[2,4],[0,4]];
  const walls = outline.map((p,i) => { const q = outline[(i+1)%outline.length]; return wall(p[0],p[1],q[0],q[1]); });
  assert.equal(polygonArea(roomAt(walls, { x: 1, z: 3 })!), 12);
  assert.equal(roomAt(walls, { x: 3, z: 3 }), undefined);
  const triangle = [wall(0,0,4,0),wall(4,0,2,3),wall(2,3,0,0)];
  assert.equal(polygonArea(roomAt(triangle, { x: 2, z: 1 })!), 6);
});

test('drawn and filled floors are independent, deletable, and undoable', () => {
  let state = editorReducer(initialEditor, { type: 'load', building: model(rectangle()) });
  const original = state.present!.floorBounds;
  state = editorReducer(state, { type: 'edit', command: { type: 'floor', start: { x: 20, z: 20 }, end: { x: 23, z: 24 } } });
  assert.equal(polygonArea(state.present!.floors![0].points), 12);
  assert.deepEqual(state.present!.floorBounds, original);
  state = editorReducer(state, { type: 'edit', command: { type: 'fill-floor', point: { x: 2, z: 2 } } });
  assert.equal(state.present!.floors!.length, 2);
  const floor = state.present!.floors![1];
  assert.ok(editBuilding(state.present!, { type: 'fill-floor', point: { x: 2, z: 2 } }).error);
  state = editorReducer(state, { type: 'edit', command: { type: 'delete-floor', floorId: floor.id } });
  assert.equal(state.present!.floors!.length, 1);
  state = editorReducer(state, { type: 'undo' }); assert.equal(state.present!.floors![1].id, floor.id);
  assert.ok(editBuilding(state.present!, { type: 'floor', start: { x: 1, z: 1 }, end: { x: 1, z: 1 } }).error);
});
