/** node packages/agent/scripts/demo.ts [scene=two-rooms-corridor.json] [people=150] — run the heuristic agent and print its steps. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from '@egress/core';
import { LocalEnvironment, runHeuristicAgent, ToolBox } from '@egress/agent';
const file = process.argv[2] ?? 'two-rooms-corridor.json', people = Number(process.argv[3] ?? 150);
const document = parseDocument(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'content', 'scenes', file), 'utf8')));
const env = new LocalEnvironment({
  document, jobId: 'demo', onStep: s => console.log(`· ${s.kind}${s.toolName ? ` ${s.toolName}` : ''} ${JSON.stringify(s.payload).slice(0, 160)}`),
  scenario: { scenarioVersion: 1, id: 's', projectId: document.projectId, name: 'Evacuate', durationSeconds: 400, population: { count: people, distribution: 'uniform', strokes: [], seed: 1 }, goal: { kind: 'evacuate', blockedExitIds: [] } },
});
const started = Date.now();
const outcome = await runHeuristicAgent(new ToolBox(env, 'demo'));
console.log(`\n${outcome.mode}, ${outcome.toolCalls} tool calls, ${Date.now() - started} ms\n${outcome.message}`);
