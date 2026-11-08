import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEdit, canonicalJson, emptyDocument, type EditCommand, type EgressDocument } from '@egress/core';
import { OptimisticDocument } from '@egress/client';

const style = { thicknessM: 0.2, heightM: 2.8, material: 'normal' } as const;
const box = (x: number): EditCommand => ({ kind: 'createBox', floorId: 'f0', min: { x, y: 0 }, max: { x: x + 4, y: 4 }, ...style });

/** Minimal authoritative server: applies requests in arrival order, like the reducer. */
class Server {
  doc: EgressDocument = emptyDocument('p', 'f0');
  log: string[] = [];
  apply(req: { requestId: string; commands: EditCommand[] }) {
    const r = applyEdit(this.doc, req);
    if (!r.ok) return r.error;
    this.doc = r.doc;
    this.log.push(req.requestId);
    return null;
  }
}

test('two clients edit concurrently; pending edits rebase and both converge on the server state', () => {
  const server = new Server();
  const a = new OptimisticDocument(), b = new OptimisticDocument();
  a.setServer(server.doc); b.setServer(server.doc);

  const ra = a.propose('reqA', [box(0)]);
  const rb = b.propose('reqB', [box(10)]);
  assert.ok(ra.ok && rb.ok);
  assert.equal(a.view!.walls.length, 4, 'A sees its own box immediately');

  assert.equal(server.apply(ra.request), null);
  // B hears about A's edit before its own is confirmed: B's box is rebased on top.
  b.setServer(server.doc, server.log);
  assert.equal(b.view!.walls.length, 8);
  assert.equal(b.pendingCount, 1);

  assert.equal(server.apply(rb.request), null);
  a.setServer(server.doc, server.log);
  b.setServer(server.doc, server.log);
  assert.equal(a.pendingCount + b.pendingCount, 0);
  assert.equal(canonicalJson(a.view), canonicalJson(server.doc));
  assert.equal(canonicalJson(b.view), canonicalJson(server.doc));
});

test('an edit made impossible by someone else is dropped with an error; undo/redo use inverse patches', () => {
  const server = new Server();
  const a = new OptimisticDocument(), b = new OptimisticDocument();
  server.apply({ requestId: 'seed', commands: [box(0)] });
  a.setServer(server.doc, server.log); b.setServer(server.doc, server.log);
  const wallId = server.doc.walls[0].id;

  const del = a.propose('del', [{ kind: 'deleteEntities', ids: [wallId] }]);
  const door = b.propose('door', [{ kind: 'createOpening', wallId, openingKind: 'door', offsetM: 2, widthM: 0.9 }]);
  assert.ok(del.ok && door.ok);
  server.apply(del.request);
  b.setServer(server.doc, server.log);
  assert.equal(b.pendingCount, 0, 'door on a deleted wall cannot rebase');
  assert.equal(b.lastError?.code, 'NOT_FOUND');

  a.setServer(server.doc, server.log);
  const undo = a.takeUndo()!;
  const u = a.propose('undo1', [undo], 'undo');
  assert.ok(u.ok);
  assert.equal(a.view!.walls.length, 4, 'wall restored');
  assert.ok(a.canRedo);
});
