import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  applyEdit, applyEditOrThrow, canonicalJson, decodeChunk, diffDocuments, emptyDocument, encodeChunk, entitiesToDocument,
  documentToEntities, layoutHash, parseDocument, parseEditRequest, sha256Hex, type EgressDocument,
} from '@egress/core';

const style = { thicknessM: 0.2, heightM: 2.8, material: 'normal' } as const;
const base = () => emptyDocument('p1', 'f0');

test('sha256Hex matches node:crypto for ASCII, unicode and block-boundary inputs', () => {
  for (const input of ['', 'abc', 'é🚪 egress', 'x'.repeat(55), 'y'.repeat(64), 'z'.repeat(1000)]) {
    assert.equal(sha256Hex(input), createHash('sha256').update(input, 'utf8').digest('hex'));
  }
});

test('canonicalJson sorts keys recursively and drops undefined', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
});

test('createBox makes 4 shared vertices and 4 walls with request-derived ids', () => {
  const r = applyEditOrThrow(base(), { requestId: 'r1', commands: [{ kind: 'createBox', floorId: 'f0', min: { x: 0, y: 0 }, max: { x: 10, y: 8 }, ...style }] });
  assert.equal(r.doc.vertices.length, 4);
  assert.equal(r.doc.walls.length, 4);
  assert.equal(r.doc.revision, 1);
  assert.deepEqual(r.created[0], ['r1.0', 'r1.1', 'r1.2', 'r1.3', 'r1.4', 'r1.5', 'r1.6', 'r1.7']);
  const degree = new Map<string, number>();
  for (const w of r.doc.walls) for (const v of [w.startVertexId, w.endVertexId]) degree.set(v, (degree.get(v) ?? 0) + 1);
  assert.deepEqual([...degree.values()], [2, 2, 2, 2]);
});

test('applyEdit is deterministic: same input, same output', () => {
  const req = { requestId: 'rq', commands: [{ kind: 'createWallChain' as const, floorId: 'f0', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }], ...style }] };
  const a = applyEditOrThrow(base(), req), b = applyEditOrThrow(base(), req);
  assert.equal(canonicalJson(a.doc), canonicalJson(b.doc));
});

test('wall chain reuses an existing vertex within 1 mm', () => {
  const one = applyEditOrThrow(base(), { requestId: 'a', commands: [{ kind: 'createWallChain', floorId: 'f0', points: [{ x: 0, y: 0 }, { x: 5, y: 0 }], ...style }] });
  const two = applyEditOrThrow(one.doc, { requestId: 'b', commands: [{ kind: 'createWallChain', floorId: 'f0', points: [{ x: 5.0004, y: 0 }, { x: 5, y: 5 }], ...style }] });
  assert.equal(two.doc.vertices.length, 3);
});

test('rejects short, duplicate and overlapping walls without changing the document', () => {
  const box = applyEditOrThrow(base(), { requestId: 'b', commands: [{ kind: 'createBox', floorId: 'f0', min: { x: 0, y: 0 }, max: { x: 6, y: 6 }, ...style }] }).doc;
  const cases = [
    [{ x: 1, y: 1 }, { x: 1.2, y: 1 }],
    [{ x: 0, y: 0 }, { x: 6, y: 0 }],
    [{ x: 2, y: 0 }, { x: 8, y: 0 }],
  ];
  for (const points of cases) {
    const r = applyEdit(box, { requestId: 'x', commands: [{ kind: 'createWallChain', floorId: 'f0', points, ...style }] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, 'INVALID_GEOMETRY');
  }
});

test('eraseByLine deletes only the walls it crosses, plus their openings and orphan vertices', () => {
  let doc = applyEditOrThrow(base(), { requestId: 'b', commands: [{ kind: 'createBox', floorId: 'f0', min: { x: 0, y: 0 }, max: { x: 10, y: 8 }, ...style }] }).doc;
  const south = doc.walls.find(w => w.startVertexId === 'b.0')!;
  doc = applyEditOrThrow(doc, { requestId: 'd', commands: [{ kind: 'createOpening', wallId: south.id, openingKind: 'exit', offsetM: 5, widthM: 1.2 }] }).doc;
  assert.equal(doc.openings.length, 1);
  const r = applyEditOrThrow(doc, { requestId: 'e', commands: [{ kind: 'eraseByLine', floorId: 'f0', from: { x: 5, y: -1 }, to: { x: 5, y: 1 } }] });
  assert.equal(r.doc.walls.length, 3);
  assert.equal(r.doc.openings.length, 0);
  assert.equal(r.doc.vertices.length, 4);
});

test('openings must fit inside the wall and not overlap', () => {
  const doc = applyEditOrThrow(base(), { requestId: 'b', commands: [{ kind: 'createWallChain', floorId: 'f0', points: [{ x: 0, y: 0 }, { x: 3, y: 0 }], ...style }] }).doc;
  const wallId = doc.walls[0].id;
  const outside = applyEdit(doc, { requestId: 'o', commands: [{ kind: 'createOpening', wallId, openingKind: 'door', offsetM: 0.3, widthM: 0.9 }] });
  assert.equal(outside.ok, false);
  if (!outside.ok) assert.equal(outside.error.code, 'OPENING_OUTSIDE_WALL');
  const overlap = applyEdit(doc, { requestId: 'o', commands: [
    { kind: 'createOpening', wallId, openingKind: 'door', offsetM: 1, widthM: 0.9 },
    { kind: 'createOpening', wallId, openingKind: 'window', offsetM: 1.6, widthM: 0.9 },
  ] });
  assert.equal(overlap.ok, false);
});

test('a batch is atomic: one bad command leaves the document untouched', () => {
  const doc = base();
  const r = applyEdit(doc, { requestId: 'x', commands: [
    { kind: 'createBox', floorId: 'f0', min: { x: 0, y: 0 }, max: { x: 4, y: 4 }, ...style },
    { kind: 'deleteEntities', ids: ['nope'] },
  ] });
  assert.equal(r.ok, false);
  assert.equal(doc.walls.length, 0);
});

test('inverse patch undoes an edit exactly, and redo reapplies it', () => {
  const start = applyEditOrThrow(base(), { requestId: 'b', commands: [{ kind: 'createBox', floorId: 'f0', min: { x: 0, y: 0 }, max: { x: 10, y: 8 }, ...style }] }).doc;
  const edit = applyEditOrThrow(start, { requestId: 'e', commands: [
    { kind: 'eraseByLine', floorId: 'f0', from: { x: 5, y: -1 }, to: { x: 5, y: 1 } },
    { kind: 'createWallChain', floorId: 'f0', points: [{ x: 0, y: 0 }, { x: 4, y: -3 }], ...style },
  ] });
  const undo = applyEditOrThrow(edit.doc, { requestId: 'u', commands: [edit.inverse] });
  assert.equal(canonicalJson({ ...undo.doc, revision: 0 }), canonicalJson({ ...start, revision: 0 }));
  const redo = applyEditOrThrow(undo.doc, { requestId: 'r', commands: [undo.inverse] });
  assert.equal(canonicalJson({ ...redo.doc, revision: 0 }), canonicalJson({ ...edit.doc, revision: 0 }));
});

test('document ⇄ entity rows round-trip regardless of row order, and diff is minimal', () => {
  const doc = applyEditOrThrow(base(), { requestId: 'b', commands: [{ kind: 'createBox', floorId: 'f0', min: { x: 0, y: 0 }, max: { x: 5, y: 5 }, ...style }] }).doc;
  const rows = documentToEntities(doc).reverse();
  const rebuilt = entitiesToDocument('p1', doc.revision, rows);
  assert.equal(canonicalJson(rebuilt), canonicalJson(doc));
  assert.equal(layoutHash(rebuilt), layoutHash(doc));
  const moved = applyEditOrThrow(doc, { requestId: 'm', commands: [{ kind: 'moveVertex', vertexId: 'b.0', to: { x: -1, y: 0 } }] });
  const diff = diffDocuments(doc, moved.doc);
  assert.deepEqual(diff.put.map(e => e.id), ['b.0']);
  assert.deepEqual(diff.remove, []);
});

test('layoutHash ignores revision and changes with geometry', () => {
  const a = base();
  const b: EgressDocument = { ...a, revision: 9 };
  assert.equal(layoutHash(a), layoutHash(b));
  const c = applyEditOrThrow(a, { requestId: 'x', commands: [{ kind: 'createBox', floorId: 'f0', min: { x: 0, y: 0 }, max: { x: 5, y: 5 }, ...style }] }).doc;
  assert.notEqual(layoutHash(a), layoutHash(c));
});

test('frame codec round-trips positions to the centimeter and keeps flags', () => {
  const actorCount = 300;
  const frames = Array.from({ length: 20 }, (_, f) => {
    const actorXY = new Float32Array(actorCount * 2);
    const actorFlags = new Uint8Array(actorCount);
    for (let a = 0; a < actorCount; a++) {
      actorXY[a * 2] = -5 + ((a * 7 + f) % 400) / 10;
      actorXY[a * 2 + 1] = -3 + ((a * 13 + f * 3) % 300) / 10;
      actorFlags[a] = (a + f) % 4;
    }
    return { tick: 40 + f, actorXY, actorFlags };
  });
  const bytes = encodeChunk({ actorCount, firstTick: 40, frames }, { x: -6, y: -4 });
  const decoded = decodeChunk(bytes);
  assert.equal(decoded.frames.length, 20);
  assert.equal(decoded.frames[7].tick, 47);
  for (let i = 0; i < frames.length; i++) {
    assert.deepEqual([...decoded.frames[i].actorFlags], [...frames[i].actorFlags]);
    for (let k = 0; k < actorCount * 2; k++) assert.ok(Math.abs(decoded.frames[i].actorXY[k] - frames[i].actorXY[k]) <= 0.0051);
  }
  assert.ok(bytes.length < 300 * 5 * 20, `chunk should compress (${bytes.length} bytes)`);
});

test('parsers reject malformed input as DomainErrors', () => {
  assert.throws(() => parseEditRequest({ projectId: 'p', requestId: 'r', baseRevision: 0, commands: [] }), /Invalid edit request/);
  assert.throws(() => parseDocument({ docVersion: 2 }), (e: Error & { code?: string }) => e.code === 'INVALID_GEOMETRY');
  assert.doesNotThrow(() => parseDocument(base()));
});
