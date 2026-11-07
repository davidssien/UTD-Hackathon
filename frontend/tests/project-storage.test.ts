import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeProject } from '../lib/project-storage.ts';

const project = { version: 1, source: '/sample-plan.svg', building: { walls: [], width: 20, depth: 10, sourceWidth: 100, sourceHeight: 50 } };
test('restores empty buildings and uploaded image sources', () => {
  assert.deepEqual(decodeProject(JSON.stringify(project)).building, project.building);
  assert.equal(decodeProject(JSON.stringify({ ...project, source: 'data:image/png;base64,abc' })).source, 'data:image/png;base64,abc');
});
test('rejects corrupt, unsupported, and unsafe saved projects', () => {
  for (const value of ['{', JSON.stringify({ ...project, version: 2 }), JSON.stringify({ ...project, source: 'blob:expired' }), JSON.stringify({ ...project, building: { ...project.building, walls: [{}] } })]) {
    assert.throws(() => decodeProject(value));
  }
});
