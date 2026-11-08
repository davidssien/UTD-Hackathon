/**
 * Two ways to drive the same tools (Plan.md §7):
 *
 * - `runLlmAgent`: Nemotron decides which tools to call (multi-step tool use).
 * - `runHeuristicAgent`: a fixed but real sequence (inspect → baseline →
 *   hotspots → test up to 3 suggestions → propose the best). Used when no
 *   model is configured, and as the fallback when the model misbehaves. It is
 *   never a canned transcript: every number comes from a simulation.
 */
import type { AgentContext, ID } from '@egress/core';
import { ToolBox, TOOL_SPECS, describeDelta, type ToolSpec } from './tools.ts';

export interface AgentOutcome {
  mode: 'llm' | 'heuristic' | 'llm+heuristic-fallback';
  message: string;
  proposalIds: ID[];
  toolCalls: number;
}

// ── Heuristic ───────────────────────────────────────────────────────────────

interface RunSummary { runId: string; evacuationTimeSeconds: number | null; effectiveTimeSeconds: number; evacuated: number; people: number; maxQueueLength: number; error?: string }
interface HotspotResult { suggestions: { suggestionId: string; title: string }[]; hotspots: { description?: string }[] }
interface CandidateResult extends RunSummary { change: string; delta: Record<string, number>; controlled: boolean }

export async function runHeuristicAgent(tools: ToolBox, context: AgentContext = {}): Promise<AgentOutcome> {
  await tools.call('inspect_layout', {});
  let baseline: RunSummary | null = null;
  if (context.runId) {
    const existing = (await tools.call('inspect_run', { runId: context.runId })) as RunSummary;
    if (!existing.error && existing.evacuationTimeSeconds !== null) baseline = existing;
  }
  if (!baseline) baseline = (await tools.call('run_scenario', {})) as RunSummary;
  if (baseline.error) return finish(tools, 'heuristic', `I could not run a baseline simulation: ${baseline.error}`);

  const hot = (await tools.call('get_hotspots', { runId: baseline.runId, topK: 3 })) as HotspotResult;
  if (!hot.suggestions?.length) {
    return finish(tools, 'heuristic', `The baseline ${describeBaseline(baseline)} with a longest queue of ${baseline.maxQueueLength}, but I found no door or exit change to test near the hotspots.`);
  }

  const results: CandidateResult[] = [];
  for (const s of hot.suggestions.slice(0, tools.budget.maxCandidates)) {
    const r = (await tools.call('test_edit_batch', { baselineRunId: baseline.runId, suggestionId: s.suggestionId })) as CandidateResult;
    if (!r.error) results.push(r);
  }
  const score = (r: CandidateResult) => (r.delta.effectiveTimeSeconds ?? 0) + (r.delta.maxQueueLength ?? 0) * 0.1;
  const best = [...results].sort((a, b) => score(a) - score(b))[0];
  if (!best || score(best) >= -0.5) {
    return finish(tools, 'heuristic', `I tested ${results.length} change(s) against a baseline that ${describeBaseline(baseline)}; none improved the modeled evacuation enough to propose.`);
  }
  const summary = `${best.change}: ${describeDelta(best.delta)} versus the baseline, with the same people and seed. This is a modeled change, not a safety certification.`;
  await tools.call('submit_proposal', { baselineRunId: baseline.runId, candidateRunId: best.runId, summary });
  return finish(tools, 'heuristic', `Worst bottleneck: ${hot.hotspots[0]?.description ?? 'unknown'}. ${summary} Review the highlighted change and accept it if you agree.`);
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

Rules:
- Every number you state must come from a tool result in this conversation. Say "modeled", never claim real-world safety or code compliance.
- Work in steps: inspect_layout, get a baseline (inspect_run if a run id is given, else run_scenario), get_hotspots, then test_edit_batch on the most promising suggestionIds (same people, same seed), then submit_proposal for the best tested candidate if it measurably helps.
- Budgets: 12 tool calls, 2 scenarios, 3 candidates. Do not repeat identical calls.
- If the first candidate does not improve the measured outcome, test another suggestion within the budget. Never submit a worse or unchanged candidate.
- When a tested candidate helps, you MUST call submit_proposal before your final summary. Describing an edit does not save a proposal. Only say a proposal was saved after submit_proposal succeeds.
- Proposals are applied only if a human accepts them.
- Finish with a short plain-language summary (3 sentences max) citing the measured before/after numbers.`;

export async function runLlmAgent(tools: ToolBox, chat: ChatFn, prompt: string, context: AgentContext = {}): Promise<AgentOutcome> {
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
        if (!tools.proposals.length && tools.tested === 0) break; // answered without measuring anything → fall back
        return finish(tools, 'llm', text);
      }
      for (const call of reply.tool_calls) {
        let args: unknown = {};
        try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch { args = { _unparsable: call.function.arguments }; }
        const result = await tools.call(call.function.name, args);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 6000) });
      }
      if (tools.calls >= tools.budget.maxToolCalls) {
        messages.push({ role: 'user', content: 'Tool budget reached. Give your final summary now, citing measured numbers only.' });
      }
    }
  } catch (e) {
    await tools.env.log({ kind: 'error', toolName: 'nemotron', payload: { message: e instanceof Error ? e.message : String(e) } });
  }
  // The model stopped early, failed, or never measured anything: finish with the real fixed sequence.
  const fallback = new ToolBox(tools.env, `${tools.jobId}.fallback`, tools.budget);
  const outcome = await runHeuristicAgent(fallback, context);
  return { ...outcome, mode: 'llm+heuristic-fallback', proposalIds: [...tools.proposals, ...outcome.proposalIds], toolCalls: tools.calls + outcome.toolCalls };
}
