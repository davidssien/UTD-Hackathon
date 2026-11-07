import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  applyEditOrThrow, deriveLayout, emptyDocument, parseDocument, pointInPolygon, signedArea, type EditCommand, type EgressDocument, type Vec2,
} from '@egress/core';

const style = { thicknessM: 0.2, heightM: 2.8, material: 'normal' } as const;
const build = (...commands: EditCommand[]) => applyEditOrThrow(emptyDocument('p', 'f0'), { requestId: 'r', commands }).doc;
const chain = (...points: [number, number][]): EditCommand => ({ kind: 'createWallChain', floorId: 'f0', points: points.map(([x, y]) => ({ x, y })), ...style });
const box = (x0: number, y0: number, x1: number, y1: number): EditCommand => ({ kind: 'createBox', floorId: 'f0', min: { x: x0, y: y0 }, max: { x: x1, y: y1 }, ...style });
const fixture = (name: string) => parseDocument(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'content', 'scenes', name), 'utf8')));

function solidAt(doc: EgressDocument, p: Vec2) {
  const { walls } = deriveLayout(doc);
  return walls.pieces.some(piece => pointInPolygon(p, piece.polygon)) || walls.hubs.some(h => pointInPolygon(p, h.polygon));
}

test('an L corner has no notch: the outer corner square is solid', () => {
  const doc = build(box(0, 0, 10, 8));
  for (const p of [{ x: -0.09, y: -0.09 }, { x: 10.09, y: 8.09 }, { x: -0.05, y: 8.05 }]) assert.ok(solidAt(doc, p), `solid at ${p.x},${p.y}`);
  assert.ok(!solidAt(doc, { x: -0.15, y: -0.15 }), 'nothing outside the wall thickness');
  assert.ok(!solidAt(doc, { x: 5, y: 4 }), 'room interior is empty');
  for (const piece of deriveLayout(doc).walls.pieces) assert.ok(signedArea(piece.polygon) > 0, 'pieces are counter-clockwise');
});

test('T and X junctions are filled by hubs', () => {
  const t = build(chain([0, 0], [10, 0]), chain([5, 0], [5, 5]));
  assert.equal(deriveLayout(t).walls.hubs.length, 1);
  assert.ok(solidAt(t, { x: 5, y: 0.05 }) && solidAt(t, { x: 4.95, y: -0.05 }) && solidAt(t, { x: 5.05, y: -0.09 }));
  const x = build(chain([0, 0], [4, 0]), chain([2, -2], [2, 2]));
  assert.equal(deriveLayout(x).walls.hubs.length, 1);
  assert.ok(solidAt(x, { x: 2, y: 0 }) && solidAt(x, { x: 2.08, y: 0.08 }));
});

test('45° and sharp 15° corners produce finite, gap-free outlines', () => {
  const diag = build(chain([0, 0], [5, 0], [10, 5]));
  assert.ok(solidAt(diag, { x: 5, y: -0.09 }), 'outer side of a 135° turn is filled');
  const sharp = build(chain([0, 0], [5, 0], [0, 1.34]));
  const { walls } = deriveLayout(sharp);
  for (const piece of walls.pieces) for (const p of piece.polygon) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  assert.ok(walls.hubs.length >= 1, 'outer corner is beveled with a hub');
  assert.ok(solidAt(sharp, { x: 5.005, y: 0 }) && solidAt(sharp, { x: 5, y: -0.05 }), 'beveled tip is solid up to the bevel');
  assert.ok(!solidAt(sharp, { x: 5.3, y: 0 }), 'no miter spike beyond the bevel');
});

test('openings cut the wall into solid stretches', () => {
  let doc = build(chain([0, 0], [6, 0]));
  doc = applyEditOrThrow(doc, { requestId: 'd', commands: [{ kind: 'createOpening', wallId: doc.walls[0].id, openingKind: 'door', offsetM: 3, widthM: 0.9 }] }).doc;
  const pieces = deriveLayout(doc).walls.pieces;
  assert.equal(pieces.length, 2);
  assert.ok(Math.abs(pieces[1].fromM - pieces[0].toM - 0.9) < 1e-9);
  assert.ok(!solidAt(doc, { x: 3, y: 0 }), 'doorway is open');
});

test('rooms and exterior come from faces of the wall graph', () => {
  const one = deriveLayout(fixture('one-room.json')).topology;
  assert.equal(one.rooms.length, 1);
  assert.ok(Math.abs(one.rooms[0].area - 80) < 1e-6);
  assert.equal(one.exterior.length, 1);
  const two = deriveLayout(fixture('two-rooms-corridor.json')).topology;
  assert.deepEqual(two.rooms.map(r => Math.round(r.area)).sort((a, b) => a - b), [32, 80, 80]);
});

test('fixtures have no diagnostics', () => {
  assert.deepEqual(deriveLayout(fixture('one-room.json')).diagnostics, []);
  assert.deepEqual(deriveLayout(fixture('two-rooms-corridor.json')).diagnostics, []);
});

test('diagnostics: not enclosed, no exit, unreachable room, exit on interior wall', () => {
  const codes = (doc: EgressDocument) => deriveLayout(doc).diagnostics.map(d => d.code).sort();
  assert.deepEqual(codes(build(chain([0, 0], [5, 0], [5, 5]))), ['NOT_ENCLOSED', 'NO_EXIT']);

  let two = build(box(0, 0, 5, 5), box(10, 0, 15, 5));
  const south = two.walls.find(w => {
    const a = two.vertices.find(v => v.id === w.startVertexId)!.position, b = two.vertices.find(v => v.id === w.endVertexId)!.position;
    return a.y === 0 && b.y === 0 && a.x < 5;
  })!;
  two = applyEditOrThrow(two, { requestId: 'e', commands: [{ kind: 'createOpening', wallId: south.id, openingKind: 'exit', offsetM: 2.5, widthM: 1.2 }] }).doc;
  assert.deepEqual(codes(two), ['UNREACHABLE_ROOM']);

  let split = build(box(0, 0, 10, 5), chain([5, 0], [5, 5]));
  const divider = split.walls.find(w => {
    const a = split.vertices.find(v => v.id === w.startVertexId)!.position, b = split.vertices.find(v => v.id === w.endVertexId)!.position;
    return a.x === 5 && b.x === 5;
  })!;
  split = applyEditOrThrow(split, { requestId: 'x', commands: [{ kind: 'createOpening', wallId: divider.id, openingKind: 'exit', offsetM: 2.5, widthM: 1.2 }] }).doc;
  assert.ok(codes(split).includes('EXIT_ON_INTERIOR_WALL'));
});
