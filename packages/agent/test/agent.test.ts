import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyEdit, parseDocument, type SimulationScenario } from '@egress/core';
import { LocalEnvironment, runHeuristicAgent, runLlmAgent, ToolBox, type ChatFn, type ChatMessage } from '@egress/agent';

const fixture = (name: string) => parseDocument(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'content', 'scenes', name), 'utf8')));
const scenario = (projectId: string, count: number): SimulationScenario => ({
  scenarioVersion: 1, id: 's', projectId, name: 'Evacuate', durationSeconds: 400,
  population: { count, distribution: 'uniform', strokes: [], seed: 3 }, goal: { kind: 'evacuate', blockedExitIds: [] },
});

function setup(name = 'one-room.json', people = 80) {
  const document = fixture(name);
  const env = new LocalEnvironment({ document, scenario: scenario(document.projectId, people), jobId: 'job1' });
  return { document, env, tools: new ToolBox(env, 'job1') };
}

test('heuristic agent measures a baseline, tests real candidates on the same people, and proposes a valid improvement', async () => {
  const { document, env, tools } = setup();
  const outcome = await runHeuristicAgent(tools);
  const kinds = env.steps.filter(s => s.kind === 'tool_call').map(s => s.toolName);
  assert.deepEqual(kinds.slice(0, 3), ['inspect_layout', 'run_scenario', 'get_hotspots']);
  assert.ok(kinds.includes('test_edit_batch') && kinds.includes('submit_proposal'), kinds.join(','));
  assert.equal(outcome.proposalIds.length, 1);
  const proposal = env.proposals[0];
  assert.ok(proposal.delta.evacuationTimeSeconds < 0, `evacuation got faster: ${JSON.stringify(proposal.delta)}`);
  const candidate = env.runs.get(proposal.candidateRunId)!;
  assert.equal(candidate.respawned, 0, 'same people as the baseline');
  assert.deepEqual(candidate.initialActors.x.slice(0, 5), env.runs.get(proposal.baselineRunId)!.initialActors.x.slice(0, 5));
  assert.ok(applyEdit(document, { requestId: 'accept', commands: proposal.commands }).ok, 'proposal is valid geometry');
  assert.ok(outcome.toolCalls <= 12);
  assert.match(outcome.message, /modeled/);
});

test('tools reject unknown tools, bad arguments, untested proposals, and enforce budgets', async () => {
  const { tools } = setup('one-room.json', 30);
  assert.match(JSON.stringify(await tools.call('rm_rf', {})), /Unknown tool/);
  assert.match(JSON.stringify(await tools.call('get_hotspots', { runId: 5 })), /Invalid arguments/);
  const base = (await tools.call('run_scenario', {})) as { runId: string };
  assert.match(JSON.stringify(await tools.call('submit_proposal', { baselineRunId: base.runId, candidateRunId: base.runId, summary: 'x' })), /Only candidates tested/);
  await tools.call('run_scenario', {});
  assert.match(JSON.stringify(await tools.call('run_scenario', {})), /Scenario budget/);
});

test('proposals reject a non-improving candidate and evidence from a different baseline', async () => {
  const { document, env, tools } = setup('one-room.json', 30);
  const base = await tools.call('run_scenario', {}) as { runId: string };
  const exit = document.openings.find(o => o.openingKind === 'exit')!;
  const candidate = await tools.call('test_edit_batch', {
    baselineRunId: base.runId,
    commands: [{ kind: 'updateOpening', openingId: exit.id, patch: { widthM: exit.widthM } }],
  }) as { runId: string; delta: Record<string, number> };
  assert.equal(candidate.delta.effectiveTimeSeconds, 0, 'unchanged geometry has no measured benefit');
  assert.match(JSON.stringify(await tools.call('submit_proposal', {
    baselineRunId: base.runId, candidateRunId: candidate.runId, summary: 'An unchanged exit.',
  })), /does not measurably improve/);
  assert.match(JSON.stringify(await tools.call('submit_proposal', {
    baselineRunId: 'another-baseline', candidateRunId: candidate.runId, summary: 'Unrelated evidence.',
  })), /baseline this candidate was tested against/);
  assert.equal(env.proposals.length, 0);
});

test('LLM loop executes the model\'s tool calls in order and returns its final answer', async () => {
  const { env, tools } = setup('one-room.json', 60);
  let baselineId = '', candidateId = '';
  const script: ((last: ChatMessage[]) => ChatMessage)[] = [
    () => call('inspect_layout', {}),
    () => call('run_scenario', {}),
    m => { baselineId = JSON.parse(m.at(-1)!.content!).runId; return call('get_hotspots', { runId: baselineId }); },
    m => call('test_edit_batch', { baselineRunId: baselineId, suggestionId: JSON.parse(m.at(-1)!.content!).suggestions[0].suggestionId }),
    m => { candidateId = JSON.parse(m.at(-1)!.content!).runId; return call('submit_proposal', { baselineRunId: baselineId, candidateRunId: candidateId, summary: 'Widen the exit (modeled).' }); },
    () => ({ role: 'assistant', content: 'Widening the exit cut the modeled evacuation time.' }),
  ];
  let i = 0;
  const chat: ChatFn = async messages => script[i++](messages);
  const outcome = await runLlmAgent(tools, chat, 'Investigate the worst bottleneck');
  assert.equal(outcome.mode, 'llm');
  assert.equal(outcome.proposalIds.length, 1);
  assert.equal(env.proposals[0].candidateRunId, candidateId);
});

test('if the model fails, the agent finishes with the real heuristic sequence', async () => {
  const { env, tools } = setup('one-room.json', 60);
  const chat: ChatFn = async () => { throw new Error('429 rate limited'); };
  const outcome = await runLlmAgent(tools, chat, 'Investigate');
  assert.equal(outcome.mode, 'llm+heuristic-fallback');
  assert.ok(env.steps.some(s => s.kind === 'error' && s.toolName === 'nemotron'));
  assert.equal(outcome.proposalIds.length, 1);
});

let callCounter = 0;
function call(name: string, args: unknown): ChatMessage {
  return { role: 'assistant', content: null, tool_calls: [{ id: `c${callCounter++}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}
