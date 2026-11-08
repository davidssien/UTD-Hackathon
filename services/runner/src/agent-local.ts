/**
 * Run the Analysis agent against a scene without SpacetimeDB:
 *
 *   node services/runner/src/agent-local.ts [scene.json] [people] ["prompt"]
 *
 * Uses Nemotron when NVIDIA_API_KEY is set (services/runner/.env), otherwise
 * the measured heuristic planner. Every number printed comes from a real run.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseDocument } from '@egress/core';
import { LocalEnvironment, runHeuristicAgent, runLlmAgent, ToolBox } from '@egress/agent';
import { config } from './config.ts';
import { hasNemotronKey, nemotronChatFn } from './llm.ts';

const [sceneArg = 'two-rooms-corridor.json', peopleArg = '150', prompt = 'Investigate the worst bottleneck and propose one measured improvement.'] = process.argv.slice(2);
const scenePath = isAbsolute(sceneArg) ? sceneArg : join(import.meta.dirname, '..', '..', '..', 'content', 'scenes', sceneArg);
const document = parseDocument(JSON.parse(readFileSync(scenePath, 'utf8')));
const jobId = `local-${Date.now().toString(36)}`;

const env = new LocalEnvironment({
  document,
  jobId,
  scenario: {
    scenarioVersion: 1, id: `${jobId}.scenario`, projectId: document.projectId, name: 'Evacuate', durationSeconds: 400,
    population: { count: Number(peopleArg), distribution: 'uniform', strokes: [], seed: 1 }, goal: { kind: 'evacuate', blockedExitIds: [] },
  },
  onStep: s => console.log(`· ${s.kind}${s.toolName ? ` ${s.toolName}` : ''} ${JSON.stringify(s.payload).slice(0, 200)}`),
});

const tools = new ToolBox(env, jobId);
const started = Date.now();
const outcome = hasNemotronKey()
  ? await runLlmAgent(tools, nemotronChatFn(line => console.log(line)), prompt)
  : (console.log(`[agent] NVIDIA_API_KEY not set; using the heuristic planner (model would be ${config.nemotronModel}).`), await runHeuristicAgent(tools, {}, prompt));

console.log(`\n[agent] mode=${outcome.mode} toolCalls=${outcome.toolCalls} proposals=${outcome.proposalIds.length} ${Date.now() - started} ms`);
console.log(outcome.message);
