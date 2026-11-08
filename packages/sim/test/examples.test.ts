import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { describeRooms, parseDocument } from '@egress/core';
import { runSimulation } from '@egress/sim';

const dir = join(import.meta.dirname, '..', '..', '..', 'content', 'examples');
const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { id: string; name: string; people: number; file: string }[];

test('there are at least three example saves of different sizes', () => {
  assert.ok(index.length >= 3);
  const areas = index.map(e => {
    const doc = parseDocument(JSON.parse(readFileSync(join(dir, e.file), 'utf8')));
    const xs = doc.vertices.map(v => v.position.x), ys = doc.vertices.map(v => v.position.y);
    return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
  });
  assert.ok(Math.max(...areas) / Math.min(...areas) > 2.5, `areas ${areas.join(', ')}`);
});

for (const example of index) {
  test(`example "${example.name}" parses, has rooms, and evacuates its suggested crowd`, () => {
    const doc = parseDocument(JSON.parse(readFileSync(join(dir, example.file), 'utf8')));
    assert.ok(describeRooms(doc).length >= 3, 'several rooms');
    assert.ok(doc.slabs.length > 0, 'floor surfaces');
    const { metrics } = runSimulation({
      runId: `ex-${example.id}`, document: doc,
      scenario: {
        scenarioVersion: 1, id: `ex-${example.id}`, projectId: doc.projectId, name: 'Evacuate', durationSeconds: 600,
        population: { count: example.people, distribution: 'uniform', strokes: [], seed: 3 }, goal: { kind: 'evacuate', blockedExitIds: [] },
      },
    }, { keepChunks: false });
    assert.equal(metrics.unreachablePeople, 0, 'everyone can reach an exit');
    assert.equal(metrics.evacuatedPeople, example.people);
    assert.ok(metrics.evacuationTimeSeconds !== null && metrics.evacuationTimeSeconds < 300, `evacuation ${metrics.evacuationTimeSeconds} s`);
  });
}
