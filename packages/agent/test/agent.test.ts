import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyEdit, DEFAULT_WALL, deriveLayout, layoutHash, openingCenter, parseDocument, type EditCommand, type SimulationScenario } from '@egress/core';
import { classifyIntent, complianceChecks, describeLayout, LocalEnvironment, runHeuristicAgent, runLlmAgent, ToolBox, type ChatFn, type ChatMessage } from '@egress/agent';

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
  assert.deepEqual(kinds.slice(0, 4), ['inspect_layout', 'check_compliance', 'run_scenario', 'get_hotspots']);
  assert.ok(kinds.includes('test_edit_batch') && kinds.includes('submit_proposal'), kinds.join(','));
  assert.equal(outcome.proposalIds.length, 1);
  const proposal = env.proposals[0];
  assert.ok(proposal.delta.evacuationTimeSeconds < 0, `evacuation got faster: ${JSON.stringify(proposal.delta)}`);
  const candidate = env.runs.get(proposal.candidateRunId)!;
  assert.equal(candidate.respawned, 0, 'same people as the baseline');
  assert.deepEqual(candidate.initialActors.x.slice(0, 5), env.runs.get(proposal.baselineRunId)!.initialActors.x.slice(0, 5));
  assert.ok(applyEdit(document, { requestId: 'accept', commands: proposal.commands }).ok, 'proposal is valid geometry');
  assert.ok(outcome.toolCalls <= 14);
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

test('heuristic agent confirms the winner on three different crowds before proposing', async () => {
  const { env, tools } = setup('two-rooms-corridor.json', 90);
  await runHeuristicAgent(tools);
  assert.ok(env.steps.some(s => s.kind === 'tool_call' && s.toolName === 'confirm_candidate'));
  const proposal = env.proposals[0];
  assert.ok(proposal, 'still proposes a robust improvement');
  assert.equal(proposal.delta.seedsTested, 3);
  assert.ok(proposal.delta.robustMeanSeconds < -0.5, JSON.stringify(proposal.delta));
  assert.match(proposal.notes.byCommand['0'], /different crowds/);
  const seeds = new Set([...env.runs.values()].map(r => r.scenario.population.seed));
  assert.equal(seeds.size, 3, 'baselines and candidates ran on three seeds');
});

test('intent: named changes, open-ended requests and questions are told apart (D72)', () => {
  assert.deepEqual(classifyIntent('Put a door at the opposite end of the hallway from the existing door'), { kind: 'targeted', opening: 'door', farEnd: true, hallway: true });
  assert.equal(classifyIntent('How could we better place a door?').kind, 'targeted');
  assert.equal(classifyIntent('Where should a second exit go?').opening, 'exit');
  assert.equal(classifyIntent('Find the worst bottleneck and fix it').kind, 'improve');
  assert.equal(classifyIntent('Why is the corridor so slow?').kind, 'question');
  assert.equal(classifyIntent('Why is it slow, and can you fix it?').kind, 'improve');
});

test('a requested placement is measured and proposed where asked, not swapped for the bottleneck fix (Courtyard)', async () => {
  const { document, env, tools } = setup('two-rooms-corridor.json', 120);
  const outcome = await runHeuristicAgent(tools, {}, 'Put a door at the opposite end of the hallway from the existing door');
  const { rooms, walls } = describeLayout(document);
  const hallway = rooms.find(r => r.kind === 'hallway')!;
  assert.ok(hallway, 'the corridor is recognized as a hallway');
  const requested = env.proposals[0];
  assert.ok(requested, outcome.message);
  assert.equal(requested.delta.requested, 1, 'the first proposal is the requested change');
  const created = requested.commands[0] as Extract<EditCommand, { kind: 'createOpening' }>;
  assert.equal(created.kind, 'createOpening');
  assert.ok(hallway.wallIds.includes(created.wallId), 'placed on a hallway wall, not a room');
  const existing = document.openings.find(o => o.openingKind === 'exit')!;
  const wall = walls.find(w => w.id === created.wallId)!;
  const t = created.offsetM / wall.lengthM;
  const at = { x: wall.from.x + (wall.to.x - wall.from.x) * t, y: wall.from.y + (wall.to.y - wall.from.y) * t };
  const from = openingCenter(document, existing)!;
  assert.ok(Math.hypot(at.x - from.x, at.y - from.y) > hallway.lengthM * 0.8, `far from the existing exit (${JSON.stringify(at)} vs ${JSON.stringify(from)})`);
  assert.match(outcome.message, /You asked for a door/);
});

test('modeled compliance flags a narrow door and offers a tested fix', async () => {
  const doc = fixture('two-rooms-corridor.json');
  const door = doc.openings.find(o => o.openingKind === 'door')!;
  const narrowed = applyEdit(doc, { requestId: 'n', commands: [{ kind: 'updateOpening', openingId: door.id, patch: { widthM: 0.7 } }] });
  assert.ok(narrowed.ok);
  const checks = complianceChecks(narrowed.doc, 120);
  assert.equal(checks.find(c => c.id === 'door-width')!.status, 'fail');
  assert.equal(checks.find(c => c.id === 'exit-count')!.status, 'fail', '120 people need 2 exits');
  const env = new LocalEnvironment({ document: narrowed.doc, scenario: scenario(narrowed.doc.projectId, 120), jobId: 'c' });
  const result = await new ToolBox(env, 'c').call('check_compliance', {}) as { suggestions: { suggestionId: string; title: string }[] };
  assert.match(result.suggestions[0].title, /Widen the 0.7 m door to 0.91 m/);
});

test('mixed optimization and corner-office request produces an accept-ready enclosed room', async () => {
  const base = fixture('one-room.json'), floorId = base.floors[0].id;
  const box = applyEdit(base, { requestId: 'square', commands: [{ kind: 'createBox', floorId, ...DEFAULT_WALL, min: { x: 4, y: 3 }, max: { x: 6, y: 5 } }] });
  assert.ok(box.ok);
  const doc = box.doc;
  const env = new LocalEnvironment({ document: doc, scenario: scenario(doc.projectId, 45), jobId: 'office' });
  const prompt = 'ow can we optmize here? I need to build a small corner office too. Can you add a corner office optimized with our current layout and for afety?';
  const outcome = await runLlmAgent(new ToolBox(env, 'office'), async () => ({ role: 'assistant', content: 'Add an exit instead.' }), prompt, { runId: 'missing' });
  assert.equal(outcome.proposalIds.length, 1, outcome.message);
  const proposal = env.proposals[0];
  assert.ok(env.runs.size > 2, 'compared several placements against the baseline');
  const accepted = applyEdit(doc, { requestId: 'accept', commands: proposal.commands });
  assert.ok(accepted.ok);
  assert.equal(deriveLayout(accepted.doc).topology.rooms.length, deriveLayout(doc).topology.rooms.length + 1);
  const newDoor = accepted.doc.openings.find(o => !doc.openings.some(old => old.id === o.id));
  assert.equal(newDoor?.openingKind, 'door');
  assert.equal(newDoor?.state, 'open');
  assert.equal(env.runs.get(proposal.candidateRunId)!.layoutHash, layoutHash(accepted.doc));
  const stale = applyEdit(base, { requestId: 'accept', commands: proposal.commands });
  assert.ok(!stale.ok && stale.error.code === 'STALE_EDIT');
});

test('a model that stops after measuring a winner still leaves the confirmed proposal', async () => {
  const { env, tools } = setup('two-rooms-corridor.json', 90);
  let baselineId = '';
  const replies: ((m: ChatMessage[]) => ChatMessage)[] = [
    () => call('run_scenario', {}),
    m => { baselineId = JSON.parse(m.at(-1)!.content!).runId; return call('get_hotspots', { runId: baselineId }); },
    m => call('test_edit_batch', { baselineRunId: baselineId, suggestionId: JSON.parse(m.at(-1)!.content!).suggestions[0].suggestionId }),
    () => ({ role: 'assistant', content: 'I now need to confirm the improvement.' }),
  ];
  const outcome = await runLlmAgent(tools, async m => replies.shift()!(m), 'Improve this layout');
  assert.equal(outcome.proposalIds.length, 1, outcome.message);
  assert.equal(env.proposals[0].delta.seedsTested, 3);
  assert.equal(tools.scenarios, 1);
});

let callCounter = 0;
function call(name: string, args: unknown): ChatMessage {
  return { role: 'assistant', content: null, tool_calls: [{ id: `c${callCounter++}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}
