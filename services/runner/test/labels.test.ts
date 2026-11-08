import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { describeRooms, parseDocument, roomFacts } from '@egress/core';
import { processLabelRequest } from '../src/labels.ts';

test('without a model key the rules label every room, and the request is claimed then published', async () => {
  const saved = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = '';
  try {
    const doc = parseDocument(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'content', 'scenes', 'two-rooms-corridor.json'), 'utf8')));
    const rooms = describeRooms(doc).map(roomFacts);
    const calls: string[] = [];
    let published: { roomHash: string; kind: string; name: string }[] = [];
    await processLabelRequest({
      claimLabelRequest: async id => { calls.push(`claim ${id}`); },
      publishRoomLabels: async (id, labels, source) => { calls.push(`publish ${id} ${source}`); published = JSON.parse(labels); },
    }, { projectId: 'p1', rooms: JSON.stringify(rooms) }, () => {});
    assert.deepEqual(calls, ['claim p1', 'publish p1 rules']);
    assert.equal(published.length, 3);
    assert.deepEqual(published.map(l => l.name).sort(), ['Hallway', 'Room 1', 'Room 2']);
  } finally {
    process.env.NVIDIA_API_KEY = saved;
  }
});
