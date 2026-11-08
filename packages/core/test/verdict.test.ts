import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ruleVerdict, VERDICT_TAGLINE, type SimulationMetrics } from '@egress/core';

const run = (patch: Partial<SimulationMetrics>): SimulationMetrics => ({
  runId: 'r', tick: 600, simulatedSeconds: 60, initialPeople: 100, evacuatedPeople: 100, remainingPeople: 0, unreachablePeople: 0,
  evacuationTimeSeconds: 45, maxQueueLength: 8, meanCongestion: 0, peakCongestion: 0, perExitThroughput: { a: 50, b: 50 },
  bottlenecks: [], endReason: 'all-out', complete: true, ...patch,
});

test('rule grades: quick and calm is great, within the target is good, slow or jammed is poor, anyone left is bad', () => {
  assert.equal(ruleVerdict(run({})).grade, 'great');
  assert.equal(ruleVerdict(run({ evacuationTimeSeconds: 110 })).grade, 'good');
  assert.equal(ruleVerdict(run({ evacuationTimeSeconds: 200 })).grade, 'poor');
  assert.equal(ruleVerdict(run({ evacuationTimeSeconds: 50, maxQueueLength: 40 })).grade, 'poor');
  const stuck = ruleVerdict(run({ evacuatedPeople: 97, remainingPeople: 3, unreachablePeople: 3 }));
  assert.equal(stuck.grade, 'bad');
  assert.match(stuck.reason, /3 people cannot reach an exit/);
  assert.equal(ruleVerdict(run({ endReason: 'timeout', evacuatedPeople: 80, remainingPeople: 20 })).grade, 'bad');
  assert.equal(VERDICT_TAGLINE.poor, 'Poor - Tests Mixed');
});
