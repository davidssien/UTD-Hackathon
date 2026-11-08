/**
 * Two ways to drive the same tools (docs/ARCHITECTURE.md §7):
 *
 * - `runLlmAgent`: Nemotron decides which tools to call (multi-step tool use).
 * - `runHeuristicAgent`: a fixed but real sequence (inspect → baseline →
 *   hotspots → test up to 3 suggestions → propose the best). Used when no
 *   model is configured, and as the fallback when the model misbehaves. It is
 *   never a canned transcript: every number comes from a simulation.
 */
import type { AgentContext, ID } from '@egress/core';
import { ToolBox, TOOL_SPECS, delta, describeDelta, summarizeRun, type ToolSpec } from './tools.ts';

export interface AgentOutcome {
  mode: 'llm' | 'heuristic' | 'llm+heuristic-fallback';
  message: string;
  proposalIds: ID[];
  toolCalls: number;
}

// ── Heuristic ───────────────────────────────────────────────────────────────

interface RunSummary { runId: string; evacuationTimeSeconds: number | null; effectiveTimeSeconds: number; evacuated: number; people: number; maxQueueLength: number; matchesLayout?: boolean; error?: string }
interface HotspotResult { suggestions: { suggestionId: string; title: string }[]; hotspots: { description?: string }[] }
interface CandidateResult extends RunSummary { change: string; delta: Record<string, number>; controlled: boolean }

/** What the user asked for (D72). The LLM decides through its tool choices; the heuristic uses this. */
export interface Intent {
  kind: 'targeted' | 'corner-room' | 'improve' | 'question';
  opening?: 'door' | 'window' | 'exit';
  farEnd: boolean;
  hallway: boolean;
}

export function classifyIntent(prompt: string): Intent {
  const p = prompt.toLowerCase();
  const opening = /\bexits?\b/.test(p) ? 'exit' : /\bwindows?\b/.test(p) ? 'window' : /\bdoor(s|way)?\b/.test(p) ? 'door' : undefined;
  const farEnd = /\b(opposite|far|other|across)\b/.test(p) || /\bend of\b/.test(p);
  const hallway = /\b(hall|hallway|corridor|passage)\b/.test(p);
  if (/\b(?:add|build|create|design|place|fit|need|partition|enclose)\b[^.!?\n]{0,75}\b(?:corner (?:office|room)|(?:small|new) office|(?:an?|the) office)\b/.test(p)) {
    return { kind: 'corner-room', farEnd, hallway };
  }
  if (opening && /\b(add|place|put|move|where|new|another|second|extra|install|create|position)\b/.test(p)) return { kind: 'targeted', opening, farEnd, hallway };
  if (/^\s*(why|what|how (many|long|much|fast)|explain|is|are|does|do|which)\b/.test(p) && !/\b(fix|improve|better|reduce|faster|change)\b/.test(p)) return { kind: 'question', farEnd, hallway };
  return { kind: 'improve', farEnd, hallway };
}

async function baselineRun(tools: ToolBox, context: AgentContext): Promise<RunSummary> {
  if (context.runId && await tools.env.getRun(context.runId)) {
    const existing = (await tools.call('inspect_run', { runId: context.runId })) as RunSummary;
    if (!existing.error && existing.matchesLayout) return existing;
  }
  return (await tools.call('run_scenario', {})) as RunSummary;
}

interface LayoutResult {
  rooms: { id: string; kind: string; areaM2: number; openingIds: string[] }[];
  walls: { id: string; outside: boolean }[];
  exits: { id: string }[];
  doors: { id: string }[];
}

export async function runHeuristicAgent(tools: ToolBox, context: AgentContext = {}, prompt = ''): Promise<AgentOutcome> {
  const intent = classifyIntent(prompt);
  const layout = (await tools.call('inspect_layout', {})) as LayoutResult;
  if (intent.kind === 'corner-room') return planRoom(tools, context, prompt);
  if (intent.kind === 'targeted' && intent.opening) return targeted(tools, context, intent, layout);
  if (intent.kind === 'question') return question(tools, context);
  return improve(tools, context);
}

/** A requested room stays in every candidate. Compare placements before publishing its measured edit. */
async function planRoom(tools: ToolBox, context: AgentContext, prompt: string): Promise<AgentOutcome> {
  const size = prompt.match(/(\d+(?:\.\d+)?)\s*m?\s*[×x]\s*(\d+(?:\.\d+)?)\s*m?\b/i);
  const plans = await tools.call('plan_corner_room', size ? { widthM: Number(size[1]), depthM: Number(size[2]) } : {}) as HotspotResult & { error?: string };
  if (!plans.suggestions?.length) {
    return finish(tools, 'heuristic', plans.error ?? 'I could not fit the requested room into a clear ground-floor corner with an accessible doorway.');
  }
  const baseline = await baselineRun(tools, context);
  if (baseline.error) return finish(tools, 'heuristic', baseline.error);
  const tested: CandidateResult[] = [];
  for (const plan of plans.suggestions.slice(0, tools.budget.maxCandidates)) {
    const candidate = await tools.call('test_edit_batch', { baselineRunId: baseline.runId, suggestionId: plan.suggestionId }) as CandidateResult;
    if (!candidate.error) tested.push(candidate);
  }
  // Favor getting more people out, then shorter effective evacuation time and shorter queues.
  const best = tested.sort((a, b) => b.evacuated - a.evacuated || a.effectiveTimeSeconds - b.effectiveTimeSeconds || a.maxQueueLength - b.maxQueueLength)[0];
  if (!best) return finish(tools, 'heuristic', 'No room placement could be simulated with the baseline crowd.');
  const summary = `Of ${tested.length} tested placements, the ${best.change} had the best modeled evacuation. The current layout ${describeBaseline(baseline)}. With the office, the layout ${describeBaseline(best)}.`;
  const saved = await tools.call('submit_proposal', { baselineRunId: baseline.runId, candidateRunId: best.runId, summary, requested: true }) as { proposalId?: string; error?: string };
  return finish(tools, 'heuristic', saved.proposalId ? `${summary} The room is ready to review.` : `The room was tested but could not be saved: ${saved.error}`);
}

/** The user named a change: measure exactly that, then offer the bottleneck fix separately. */
async function targeted(tools: ToolBox, context: AgentContext, intent: Intent, layout: LayoutResult): Promise<AgentOutcome> {
  const baseline = await baselineRun(tools, context);
  if (baseline.error) return finish(tools, 'heuristic', `I could not run a baseline simulation: ${baseline.error}`);
  const rooms = [...layout.rooms].sort((a, b) => b.areaM2 - a.areaM2);
  const room = (intent.hallway ? rooms.find(r => r.kind === 'hallway') : undefined) ?? (intent.farEnd ? rooms.find(r => r.kind === 'hallway') : undefined) ?? rooms[0];
  const egress = new Set([...layout.exits, ...layout.doors].map(o => o.id));
  const reference = intent.farEnd && room ? room.openingIds.find(id => layout.exits.some(e => e.id === id)) ?? room.openingIds.find(id => egress.has(id)) : undefined;
  const ask = { kind: intent.opening!, ...(room ? { roomId: room.id } : {}), ...(reference ? { farthestFromOpeningId: reference } : { at: 'center' as const }) };
  let placed = (await tools.call('place_opening', ask)) as { suggestionId?: string; wallId?: string; offsetM?: number; description?: string; error?: string };
  // A door in an outside wall is a way out, so it is modeled as an exit.
  if (!placed.error && intent.opening === 'door' && layout.walls.find(w => w.id === placed.wallId)?.outside) {
    const asExit = (await tools.call('place_opening', { kind: 'exit', wallId: placed.wallId!, offsetM: placed.offsetM! })) as typeof placed;
    if (!asExit.error) placed = { ...asExit, description: `${asExit.description} (an outside door, modeled as an exit)` };
  }
  if (placed.error) return finish(tools, 'heuristic', `I could not place that ${intent.opening}: ${placed.error}`);
  const asked = (await tools.call('test_edit_batch', { baselineRunId: baseline.runId, suggestionId: placed.suggestionId })) as CandidateResult;
  if (asked.error) return finish(tools, 'heuristic', `The requested change could not be tested: ${asked.error}`);
  const askedScore = (asked.delta.effectiveTimeSeconds ?? 0) + (asked.delta.maxQueueLength ?? 0) * 0.1;
  const askedSummary = `${placed.description}: ${describeDelta(asked.delta)} versus the baseline, with the same people and seed. This is a modeled change, not a safety certification.`;
  const saved = await tools.call('submit_proposal', { baselineRunId: baseline.runId, candidateRunId: asked.runId, summary: askedSummary, requested: true }) as { proposalId?: string; error?: string };
  if (!saved.proposalId) return finish(tools, 'heuristic', `The requested change was tested but could not be saved: ${saved.error}`);

  // The bottleneck fix, offered as a separate alternative if it does better.
  const hot = (await tools.call('get_hotspots', { runId: baseline.runId, topK: 3 })) as HotspotResult;
  const alt = hot.suggestions?.[0] ? (await tools.call('test_edit_batch', { baselineRunId: baseline.runId, suggestionId: hot.suggestions[0].suggestionId })) as CandidateResult : null;
  const altScore = alt && !alt.error ? (alt.delta.effectiveTimeSeconds ?? 0) + (alt.delta.maxQueueLength ?? 0) * 0.1 : Infinity;
  let altLine = '';
  if (alt && !alt.error && altScore < -0.5 && altScore < askedScore - 0.5) {
    const alternative = await tools.call('submit_proposal', { baselineRunId: baseline.runId, candidateRunId: alt.runId, summary: `${alt.change}: ${describeDelta(alt.delta)}. Offered as an alternative to the requested change. Modeled, not a certification.` }) as { proposalId?: string };
    if (alternative.proposalId) altLine = ` For comparison, the worst bottleneck fix (${alt.change}) measured ${describeDelta(alt.delta)}; I left it as a second proposal.`;
  }
  const verdict = askedScore < -0.5 ? 'It helps.' : 'It does not improve the modeled evacuation, but it is there to review as asked.';
  return finish(tools, 'heuristic', `You asked for a ${intent.opening}${intent.farEnd ? ' at the far end' : ''}${room?.kind === 'hallway' ? ' of the hallway' : ''}. I placed ${placed.description?.replace(/^A /, 'a ')} and measured ${describeDelta(asked.delta)}. ${verdict}${altLine}`);
}

/** A question: measure and explain, change nothing. */
async function question(tools: ToolBox, context: AgentContext): Promise<AgentOutcome> {
  const baseline = await baselineRun(tools, context);
  if (baseline.error) return finish(tools, 'heuristic', `I could not run a baseline simulation: ${baseline.error}`);
  const hot = (await tools.call('get_hotspots', { runId: baseline.runId, topK: 3 })) as HotspotResult;
  const where = hot.hotspots?.[0]?.description ? ` The worst congestion: ${hot.hotspots[0].description}.` : '';
  return finish(tools, 'heuristic', `The modeled evacuation ${describeBaseline(baseline)}, with a longest queue of ${baseline.maxQueueLength} people.${where} Ask me to change something and I will test it on the same crowd.`);
}

/** Open-ended: modeled code checks, then the worst bottleneck. */
async function improve(tools: ToolBox, context: AgentContext): Promise<AgentOutcome> {
  const compliance = (await tools.call('check_compliance', {})) as { checks?: { title: string; status: string; detail: string }[]; suggestions?: { suggestionId: string; title: string }[] };
  const failing = (compliance.checks ?? []).filter(c => c.status === 'fail');
  const baseline = await baselineRun(tools, context);
  if (baseline.error) return finish(tools, 'heuristic', `I could not run a baseline simulation: ${baseline.error}`);

  const hot = (await tools.call('get_hotspots', { runId: baseline.runId, topK: 3 })) as HotspotResult;
  const pool = [...(compliance.suggestions ?? []), ...(hot.suggestions ?? [])];
  if (!pool.length) {
    return finish(tools, 'heuristic', `The baseline ${describeBaseline(baseline)} with a longest queue of ${baseline.maxQueueLength}, but I found no door or exit change to test near the hotspots.`);
  }

  const results: CandidateResult[] = [];
  for (const s of pool.slice(0, tools.budget.maxCandidates)) {
    const r = (await tools.call('test_edit_batch', { baselineRunId: baseline.runId, suggestionId: s.suggestionId })) as CandidateResult;
    if (!r.error) results.push(r);
  }
  return proposeImprovement(tools, results, baseline, hot);
}

async function proposeImprovement(tools: ToolBox, results: CandidateResult[], baseline: RunSummary, hot?: HotspotResult): Promise<AgentOutcome> {
  const score = (r: CandidateResult) => (r.delta.effectiveTimeSeconds ?? 0) + (r.delta.maxQueueLength ?? 0) * 0.1;
  const best = [...results].sort((a, b) => score(a) - score(b))[0];
  if (!best || score(best) >= -0.5) {
    return finish(tools, 'heuristic', `I tested ${results.length} change(s) against a baseline that ${describeBaseline(baseline)}; none improved the modeled evacuation enough to propose.`);
  }
  // Make sure the win is not a quirk of one crowd: re-test on two more seeds before proposing.
  const robust = (tools.robustness.get(best.runId) ?? await tools.call('confirm_candidate', { candidateRunId: best.runId })) as { meanSeconds?: number; worstSeconds?: number; seeds?: number[]; improvedOnAll?: boolean; error?: string };
  if (robust.error) return finish(tools, 'heuristic', `I tested ${best.change} but could not confirm it on additional crowds: ${robust.error}`);
  if ((robust.meanSeconds ?? 0) >= -0.5) {
    return finish(tools, 'heuristic', `${best.change} looked better with one crowd (${describeDelta(best.delta)}), but across ${robust.seeds?.length ?? 3} different crowds the mean change was ${robust.meanSeconds} s, so I am not proposing it.`);
  }
  const across = ` Across ${robust.seeds?.length} different crowds: mean ${robust.meanSeconds} s, worst ${robust.worstSeconds} s.`;
  const summary = `${best.change}: ${describeDelta(best.delta)} versus the baseline, with the same people and seed.${across} This is a modeled change, not a safety certification.`;
  const saved = await tools.call('submit_proposal', { baselineRunId: baseline.runId, candidateRunId: best.runId, summary }) as { proposalId?: string; error?: string };
  if (!saved.proposalId) return finish(tools, 'heuristic', `The tested change could not be saved: ${saved.error}`);
  return finish(tools, 'heuristic', `${hot?.hotspots[0]?.description ? hot.hotspots[0].description + '. ' : ''}${summary} Review the highlighted change and accept it if you agree.`);
}

function describeBaseline(b: RunSummary): string {
  return b.evacuationTimeSeconds !== null
    ? `evacuated all ${b.people} people in ${b.evacuationTimeSeconds} s`
    : `got ${b.evacuated} of ${b.people} people out before the time limit`;
}

async function finish(tools: ToolBox, mode: AgentOutcome['mode'], message: string): Promise<AgentOutcome> {
  await tools.env.log({ kind: 'message', toolName: '', payload: { text: message } });
  return { mode, message, proposalIds: [...tools.proposals], toolCalls: tools.calls };
}

// ── LLM ─────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export type ChatFn = (messages: ChatMessage[], tools: ToolSpec[]) => Promise<ChatMessage>;

export const SYSTEM_PROMPT = `You are Egress's building-flow analysis agent. You investigate evacuation bottlenecks in a 2D building model using tools, never guesses.

First decide what the user asked for, and answer THAT:
- To build a room or corner office, call plan_corner_room and test its placements. Submit the best requested room. Keep its partitions and doorway together in the proposal.
- A specific change ("add a door at the far end of the hallway", "move the exit", "where should a second exit go"): call inspect_layout to find the rooms, walls and openings they mean (room kinds include "hallway"), then place_opening to turn it into a suggestionId, test_edit_batch it, and submit_proposal with requested=true even if it does not help. Say honestly what it measured. Then you may test the worst-bottleneck fix from get_hotspots and submit it as a second, separate proposal only if it does clearly better. Never replace the requested change with a different one.
- For other requested partitions or wall moves, inspect the actual wall endpoints, test native edit commands with test_edit_batch, and submit the measured requested design.
- An open-ended request ("improve this", "fix the worst bottleneck"): check_compliance, get a baseline, get_hotspots, test the most promising suggestionIds, confirm_candidate on the best, and submit_proposal if it helps on average.
- A question ("why is the corridor slow?", "how long does it take?"): measure and explain; do not propose changes.

Rules:
- Every number you state must come from a tool result in this conversation. Say "modeled"; check_compliance gives modeled checks, never a code approval or a safety certification.
- Get a baseline with inspect_run if a run id is given, else run_scenario. Candidates rerun the same people and seed.
- Budgets: 14 tool calls, 2 scenarios, 4 candidates, 1 confirmation, 2 proposals. Do not repeat identical calls.
- Never submit a worse or unchanged candidate unless it is the user's requested change (requested=true).
- When a proposal should exist, you MUST call submit_proposal before your final summary. Only say a proposal was saved after submit_proposal succeeds. Proposals are applied only if a human accepts them.
- Finish with a short plain-language summary (3 sentences max) citing the measured before/after numbers.`;

export async function runLlmAgent(tools: ToolBox, chat: ChatFn, prompt: string, context: AgentContext = {}): Promise<AgentOutcome> {
  const intent = classifyIntent(prompt);
  // A concrete room request has a bounded spatial search. Never substitute a generic exit edit.
  if (intent.kind === 'corner-room') return runHeuristicAgent(tools, context, prompt);
  // A runner may have restarted since the live run. Only offer the model an inspectable run.
  if (context.runId && !(await tools.env.getRun(context.runId))) context = { ...context, runId: undefined };
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `${prompt}\n\nContext: ${JSON.stringify(context)}` },
  ];
  try {
    for (let turn = 0; turn < tools.budget.maxToolCalls + 2; turn++) {
      const reply = await chat(messages, TOOL_SPECS);
      messages.push({ role: 'assistant', content: reply.content ?? null, tool_calls: reply.tool_calls });
      if (reply.content && reply.tool_calls?.length) await tools.env.log({ kind: 'thought', toolName: '', payload: { text: reply.content } });
      if (!reply.tool_calls?.length) {
        const text = (reply.content ?? '').trim();
        if (!text) break;
        if (tools.proposals.length || (intent.kind === 'question' && tools.calls > 0)) return finish(tools, 'llm', text);
        break; // Finish the measured work before accepting a prose-only answer.
      }
      for (const call of reply.tool_calls) {
        let args: unknown = {};
        try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch { args = { _unparsable: call.function.arguments }; }
        if (intent.kind === 'improve' && tools.tested && !tools.proposals.length && tools.calls >= tools.budget.maxToolCalls - 2) break;
        const result = await tools.call(call.function.name, args);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 6000) });
      }
      if (intent.kind === 'improve' && tools.tested && !tools.proposals.length && tools.calls >= tools.budget.maxToolCalls - 2) break;
      if (tools.calls >= tools.budget.maxToolCalls) {
        messages.push({ role: 'user', content: 'Tool budget reached. Give your final summary now, citing measured numbers only.' });
      }
    }
  } catch (e) {
    await tools.env.log({ kind: 'error', toolName: 'nemotron', payload: { message: e instanceof Error ? e.message : String(e) } });
  }
  if (tools.proposals.length) return finish(tools, 'llm', 'The tested proposal is ready to review.');
  if (intent.kind === 'improve' && tools.candidates.size) {
    const candidates = [...tools.candidates.values()];
    const base = await tools.env.getRun(candidates[0].baselineRunId);
    if (base) {
      const results = candidates.filter(c => c.baselineRunId === base.runId).map(c => ({
        ...summarizeRun(c.run), change: c.run.label, delta: delta(base.metrics, c.run.metrics), controlled: !c.run.respawned,
      }));
      const outcome = await proposeImprovement(tools, results, summarizeRun(base));
      return { ...outcome, mode: 'llm+heuristic-fallback' };
    }
  }
  // The model stopped early, failed, or never measured anything: finish with the real fixed sequence.
  const fallback = new ToolBox(tools.env, `${tools.jobId}.fallback`, tools.budget);
  const outcome = await runHeuristicAgent(fallback, context, prompt);
  return { ...outcome, mode: 'llm+heuristic-fallback', proposalIds: [...tools.proposals, ...outcome.proposalIds], toolCalls: tools.calls + outcome.toolCalls };
}
