import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertDocumentIntegrity, parseDocument } from '@egress/core';

const scenes = join(import.meta.dirname, '..', '..', '..', 'content', 'scenes');
const files = readdirSync(scenes).filter(f => f.endsWith('.json'));

test('scene fixtures exist', () => {
  assert.ok(files.includes('one-room.json'));
  assert.ok(files.includes('two-rooms-corridor.json'));
});

for (const file of files) {
  test(`fixture ${file} parses, keeps integrity and has an exit`, () => {
    const doc = parseDocument(JSON.parse(readFileSync(join(scenes, file), 'utf8')));
    assertDocumentIntegrity(doc);
    assert.ok(doc.openings.some(o => o.openingKind === 'exit'), 'needs at least one exit');
  });
}
