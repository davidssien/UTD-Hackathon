import assert from 'node:assert/strict';
import { test } from 'node:test';
import { locksEditing, RUN_LOCK_STALE_MS } from '@egress/core';

test('only a fresh queued or running user run locks editing (D89)', () => {
  const now = 1_000_000;
  const run = { status: 'running', agentJobId: null, updatedAtMs: now - 1000 };
  assert.equal(locksEditing(run, now), true);
  assert.equal(locksEditing({ ...run, status: 'queued' }, now), true);
  for (const status of ['complete', 'failed', 'cancelled']) assert.equal(locksEditing({ ...run, status }, now), false, status);
  assert.equal(locksEditing({ ...run, agentJobId: 'job-1' }, now), false, 'agent runs never lock');
  assert.equal(locksEditing({ ...run, agentJobId: '' }, now), true, "the module stores '' for user runs");
  assert.equal(locksEditing({ ...run, updatedAtMs: now - RUN_LOCK_STALE_MS - 1 }, now), false, 'a stalled run stops locking');
});
