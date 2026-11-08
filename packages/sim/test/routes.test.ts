import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyEdit, describeRooms, parseDocument } from '@egress/core';
import { escapeRoutes } from '@egress/sim';

const fixture = (name: string) => parseDocument(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'content', 'scenes', name), 'utf8')));

test('escape routes: one per exit from a room, shortest first, ending at the exit (D73)', () => {
  let doc = fixture('two-rooms-corridor.json');
  const vs = new Map(doc.vertices.map(v => [v.id, v.position]));
  const maxX = Math.max(...doc.vertices.map(v => v.position.x));
  const east = doc.walls.map(w => ({ w, a: vs.get(w.startVertexId)!, b: vs.get(w.endVertexId)! }))
    .filter(c => Math.abs(c.a.x - maxX) < 0.01 && Math.abs(c.b.x - maxX) < 0.01).sort((p, q) => (p.a.y + p.b.y) - (q.a.y + q.b.y))[0];
  const len = Math.hypot(east.b.x - east.a.x, east.b.y - east.a.y);
  const r = applyEdit(doc, { requestId: 'x', commands: [{ kind: 'createOpening', wallId: east.w.id, openingKind: 'exit', offsetM: len / 2, widthM: 1.2 }] });
  assert.ok(r.ok); doc = r.doc;

  const room = describeRooms(doc).find(d => d.ruleKind === 'room')!;
  const routes = escapeRoutes(doc, room.center, room.polygon);
  assert.equal(routes.length, 2, 'a route to each exit');
  assert.ok(routes[0].distanceM <= routes[1].distanceM);
  for (const route of routes) {
    const exit = doc.openings.find(o => o.id === route.exitId)!;
    assert.equal(exit.openingKind, 'exit');
    assert.ok(route.path.length >= 2 && route.seconds > 0);
    const end = route.path.at(-1)!, start = route.path[0];
    assert.ok(Math.hypot(start.x - room.center.x, start.y - room.center.y) < 1, 'starts at the room');
    assert.ok(end.x !== start.x || end.y !== start.y);
  }
});
