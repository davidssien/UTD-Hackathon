import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyEdit, describeRooms, parseDocument, roomHash } from '@egress/core';

const fixture = (name: string) => parseDocument(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'content', 'scenes', name), 'utf8')));

test('room hash ignores where the outline starts and changes when the room changes (D73)', () => {
  const square = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }];
  assert.equal(roomHash(square), roomHash([...square.slice(2), ...square.slice(0, 2)]));
  assert.notEqual(roomHash(square), roomHash([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 4 }, { x: 0, y: 4 }]));
  assert.match(roomHash(square), /^[0-9a-f]{16}$/);
});

test('courtyard: two rooms and a hallway; editing elsewhere keeps the room hashes', () => {
  const doc = fixture('two-rooms-corridor.json');
  const rooms = describeRooms(doc);
  assert.deepEqual(rooms.map(r => r.ruleKind).sort(), ['hallway', 'room', 'room']);
  const hall = rooms.find(r => r.ruleKind === 'hallway')!;
  assert.equal(hall.exits, 1);
  assert.equal(new Set(rooms.map(r => r.roomHash)).size, 3);
  const door = doc.openings.find(o => o.openingKind === 'door')!;
  const widened = applyEdit(doc, { requestId: 'w', commands: [{ kind: 'updateOpening', openingId: door.id, patch: { widthM: 1.2 } }] });
  assert.ok(widened.ok);
  assert.deepEqual(describeRooms(widened.doc).map(r => r.roomHash).sort(), rooms.map(r => r.roomHash).sort(), 'labels survive edits that do not reshape rooms');
});
