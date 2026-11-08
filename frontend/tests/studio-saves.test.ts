import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { emptyDocument, parseDocument } from '@egress/core';
import { createLocalStudioClient, STUDIO_SAVE_KEY } from '../lib/studio-saves.ts';

const fixture = () => parseDocument(JSON.parse(readFileSync(new URL('../../content/scenes/two-rooms-corridor.json', import.meta.url), 'utf8')));
const memoryStorage = () => {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
};

test('local slots retain edits, multiple plans and the active slot across reload', async () => {
  const storage = memoryStorage(), client = createLocalStudioClient(storage, fixture());
  const first = client.projects.get()[0].id;
  const wall = client.document.get().doc!.walls[0];
  assert.equal((await client.edit([{ kind: 'updateWall', wallId: wall.id, patch: { material: 'glass' } }])).ok, true);
  const second = await client.createProject('New room', emptyDocument('new'));
  const floorId = client.document.get().doc!.floors[0].id;
  assert.equal((await client.edit([{ kind: 'createBox', floorId, min: { x: 0, y: 0 }, max: { x: 8, y: 6 }, thicknessM: .2, heightM: 2.8, material: 'reinforced' }])).ok, true);
  assert.notEqual(first, second);
  client.dispose();
  const restored = createLocalStudioClient(storage, fixture());
  assert.equal(restored.projects.get().length, 2);
  assert.equal(restored.projects.get().find(p => p.id === restored.document.get().projectId)?.name, 'New room');
  assert.equal(restored.document.get().doc!.walls.length, 4);
  assert.ok(restored.document.get().doc!.walls.every(w => w.material === 'reinforced'));
  await restored.openProject(restored.projects.get()[0].id);
  assert.equal(restored.document.get().doc!.walls.find(w => w.id === wall.id)?.material, 'glass');
  restored.dispose();
});

test('unreadable saves are preserved instead of being overwritten by the example', async () => {
  const storage = memoryStorage(), warnings: string[] = [];
  storage.setItem(STUDIO_SAVE_KEY, 'unreadable saved data');
  const client = createLocalStudioClient(storage, fixture(), message => warnings.push(message));
  await client.createProject('Recovery plan');
  client.dispose();
  assert.equal(storage.getItem(STUDIO_SAVE_KEY), 'unreadable saved data');
  assert.equal(warnings.length, 1);
});
