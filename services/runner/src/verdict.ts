/**
 * Run verdicts: Nemotron chooses one of four grades for a finished user run from building facts and
 * the measured outcome, anchored on (and falling back to) the rule grade in @egress/core.
 */
import { buildingFacts, ruleVerdict, verdictMeasures, type EgressDocument, type SimulationMetrics } from '@egress/core';
import { z } from 'zod';
import { hasNemotronKey } from './llm.ts';
import { chat } from './nemotron.ts';

export type Verdict = NonNullable<SimulationMetrics['verdict']>;

const PROMPT = `You grade a building evacuation simulation for an evacuation planning tool. Choose exactly one grade:
"great": passed comfortably (everyone out quickly, short queues, exits shared).
"good": passed (everyone out within the 150 s egress target).
"poor": mixed (everyone out, but slowly, with heavy queueing, or with one exit doing most of the work).
"bad": failed (anyone could not reach an exit, or the evacuation did not finish).
You get building facts, the measured outcome and a rule-based grade. Keep the rule grade unless the facts clearly justify one step up or down.
Answer with ONLY JSON: {"grade": "great|good|poor|bad", "reason": "one short sentence that cites the numbers"}.`;

const Answer = z.object({ grade: z.enum(['great', 'good', 'poor', 'bad']), reason: z.string().trim().min(1).max(300) });

export async function judgeRun(doc: EgressDocument, metrics: SimulationMetrics, log: (line: string) => void = () => {}): Promise<Verdict> {
  const rule = ruleVerdict(metrics);
  if (!hasNemotronKey()) return { ...rule, source: 'rules' };
  try {
    const { message } = await chat([
      { role: 'system', content: PROMPT },
      { role: 'user', content: JSON.stringify({ building: buildingFacts(doc), outcome: verdictMeasures(metrics), ruleGrade: rule.grade, ruleReason: rule.reason }) },
    ], { temperature: 0, maxTokens: 200, timeoutMs: 20_000, thinking: false });
    const text = message.content || String((message as { reasoning_content?: unknown }).reasoning_content ?? '');
    const answer = Answer.parse(JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)));
    // A failed run stays failed whatever the model says.
    return { grade: rule.grade === 'bad' ? 'bad' : answer.grade, reason: answer.reason, source: 'nemotron' };
  } catch (e) {
    log(`[verdict] Nemotron grading failed, using rules: ${e instanceof Error ? e.message : String(e)}`);
    return { ...rule, source: 'rules' };
  }
}
