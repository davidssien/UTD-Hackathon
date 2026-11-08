import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  canonicalJson, decodeChunk, decodeFieldBundle, layoutHash, parseDocument, parseMetrics,
  type AgentStepKind, type EditCommand, type EgressDocument, type ID, type ProposalNotes,
} from '@egress/core';
import type { RunRecord } from '@egress/agent';
import { processAgentJob, processRun, type Clock, type RunnerBackend } from '../src/jobs.ts';

const fixture = (name: string) => parseDocument(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'content', 'scenes', name), 'utf8')));
const scenarioJson = (doc: EgressDocument, count: number) => canonicalJson({
  scenarioVersion: 1, id: 's', projectId: doc.projectId, name: 'Evacuate', durationSeconds: 300,
  population: { count, distribution: 'uniform', strokes: [], seed: 4 }, goal: { kind: 'evacuate', blockedExitIds: [] },
});

class FakeBackend implements RunnerBackend {
  snapshots = new Map<string, EgressDocument>();
  chunks: { runId: ID; index: number; firstTick: number; lastTick: number; bytes: Uint8Array }[] = [];
  results = new Map<ID, { metrics: string; fields: Uint8Array; grid: string }>();
  failures: { runId: ID; code: string }[] = [];
  claimed: ID[] = [];
  cancelled = new Set<ID>();
  agentRuns: ID[] = [];
  steps: { kind: AgentStepKind; toolName: string }[] = [];
  proposals: { id: ID; commands: EditCommand[]; notes: ProposalNotes; delta: Record<string, number> }[] = [];
  finished: { status: string; summary: string }[] = [];
  records = new Map<ID, RunRecord>();

  async claimRun(runId: ID) { this.claimed.push(runId); }
  async loadSnapshot(hash: string) {
    const doc = this.snapshots.get(hash);
    if (!doc) throw new Error(`no snapshot ${hash}`);
    return doc;
  }
  async appendChunk(runId: ID, index: number, firstTick: number, lastTick: number, _encoding: string, bytes: Uint8Array) { this.chunks.push({ runId, index, firstTick, lastTick, bytes }); }
  async publishResult(runId: ID, metrics: string, fields: Uint8Array, grid: string) { this.results.set(runId, { metrics, fields, grid }); }
  async failRun(runId: ID, code: string) { this.failures.push({ runId, code }); }
  isCancelled(runId: ID) { return this.cancelled.has(runId); }
  async claimAgentJob() {}
  async startAgentRun(runId: ID) { this.agentRuns.push(runId); }
  async appendAgentStep(_jobId: ID, _seq: number, kind: AgentStepKind, toolName: string) { this.steps.push({ kind, toolName }); }
  async publishProposal(id: ID, _jobId: ID, commands: EditCommand[], notes: ProposalNotes, _b: ID, _c: ID, delta: Record<string, number>) { this.proposals.push({ id, commands, notes, delta }); }
  async finishAgentJob(_jobId: ID, status: 'complete' | 'failed', summary: string) { this.finished.push({ status, summary }); }
  findRunRecord(runId: ID) { return this.records.get(runId); }
}

function fakeClock(): Clock & { slept: number } {
  let now = 0;
  const clock = { slept: 0, now: () => now, sleep: async (ms: number) => { clock.slept += ms; now += ms; } };
  return clock;
}

test('processRun streams decodable 2 s chunks, publishes results, and paces against the clock', async () => {
  const doc = fixture('one-room.json');
  const backend = new FakeBackend();
  backend.snapshots.set(layoutHash(doc), doc);
  const clock = fakeClock();
  const outcome = await processRun(backend, { runId: 'r1', layoutHash: layoutHash(doc), scenarioJson: scenarioJson(doc, 40), pace: 'x2' }, { clock });
  assert.deepEqual(backend.claimed, ['r1']);
  assert.ok(backend.chunks.length > 5);
  const first = decodeChunk(backend.chunks[0].bytes);
  assert.equal(first.frames.length, 20);
  assert.equal(first.frames[0].actorFlags.length, 40);
  backend.chunks.forEach((c, i) => assert.equal(c.index, i));
  const metrics = parseMetrics(JSON.parse(backend.results.get('r1')!.metrics));
  assert.equal(metrics.evacuatedPeople, 40);
  const fields = decodeFieldBundle(backend.results.get('r1')!.fields);
  assert.ok(fields.fields['people.congestion/timeAverage'].some(v => v > 0));
  // x2 pace: simulated seconds / 2 of wall time spent sleeping (fake clock), give or take the last chunk.
  const simulated = outcome.metrics!.simulatedSeconds;
  assert.ok(Math.abs(clock.slept / 1000 - simulated / 2) < 2.5, `slept ${clock.slept} ms for ${simulated} s simulated`);
});

test('processRun reports infeasible populations and stops on cancellation', async () => {
  const doc = fixture('one-room.json');
  const backend = new FakeBackend();
  backend.snapshots.set(layoutHash(doc), doc);
  await processRun(backend, { runId: 'big', layoutHash: layoutHash(doc), scenarioJson: scenarioJson(doc, 900), pace: 'unpaced' });
  assert.deepEqual(backend.failures, [{ runId: 'big', code: 'POPULATION_INFEASIBLE' }]);
  backend.cancelled.add('c');
  await processRun(backend, { runId: 'c', layoutHash: layoutHash(doc), scenarioJson: scenarioJson(doc, 40), pace: 'unpaced' });
  assert.equal(backend.chunks.filter(c => c.runId === 'c').length, 1);
  assert.equal(backend.results.has('c'), false);
});

test('processAgentJob runs real tool calls as agent runs and publishes a measured proposal', async () => {
  const doc = fixture('two-rooms-corridor.json');
  const backend = new FakeBackend();
  backend.snapshots.set('snap', doc);
  await processAgentJob(backend, { jobId: 'job1', projectId: doc.projectId, prompt: 'Find the bottleneck', contextJson: '{}', snapshotHash: 'snap' }, { defaultPeople: 100 });
  assert.equal(backend.finished[0].status, 'complete', backend.finished[0].summary);
  assert.ok(backend.agentRuns.length >= 2, 'baseline + candidates became runs');
  assert.ok(backend.steps.some(s => s.toolName === 'test_edit_batch'));
  assert.equal(backend.proposals.length, 1);
  assert.ok(backend.proposals[0].delta.evacuationTimeSeconds < 0);
  assert.ok(backend.results.size >= 2, 'agent runs publish results too');
});
