/**
 * Run verdicts: one of four grades for a finished evacuation, from building facts and measured
 * outcomes we already have. The runner asks Nemotron to choose (with these rules as its anchor
 * and fallback); the in-browser mock uses the rules directly.
 */
import { describeRooms } from './derive/rooms.ts';
import type { EgressDocument, SimulationMetrics } from './types.ts';

export type VerdictGrade = 'great' | 'good' | 'poor' | 'bad';
export const VERDICT_GRADES: VerdictGrade[] = ['great', 'good', 'poor', 'bad'];
export const VERDICT_TAGLINE: Record<VerdictGrade, string> = {
  great: 'Great - Tests Passed', good: 'Good - Tests Passed', poor: 'Poor - Tests Mixed', bad: 'Bad - Tests Failed',
};

/** Above this many seconds an evacuation no longer counts as a pass (a common 2.5-minute egress target). */
export const EGRESS_TARGET_S = 150;

export interface BuildingFacts {
  floors: number;
  rooms: number;
  hallways: number;
  exits: number;
  stairs: number;
  floorAreaM2: number;
}

export function buildingFacts(doc: EgressDocument): BuildingFacts {
  const rooms = describeRooms(doc);
  return {
    floors: doc.floors.length,
    rooms: rooms.filter(r => r.ruleKind !== 'hallway').length,
    hallways: rooms.filter(r => r.ruleKind === 'hallway').length,
    exits: doc.openings.filter(o => o.openingKind === 'exit').length,
    stairs: doc.stairs.length,
    floorAreaM2: Math.round(rooms.reduce((s, r) => s + r.areaM2, 0)),
  };
}

/** The measured outcome in the terms the grade uses. */
export function verdictMeasures(m: SimulationMetrics) {
  const total = Object.values(m.perExitThroughput).reduce((s, n) => s + n, 0);
  return {
    people: m.initialPeople,
    evacuated: m.evacuatedPeople,
    unreachable: m.unreachablePeople,
    finished: m.endReason === 'all-out',
    evacuationSeconds: m.evacuationTimeSeconds,
    maxQueueShare: m.initialPeople ? Math.round((m.maxQueueLength / m.initialPeople) * 100) / 100 : 0,
    busiestExitShare: total ? Math.round((Math.max(...Object.values(m.perExitThroughput)) / total) * 100) / 100 : 0,
    exitSwitches: m.exitSwitches ?? 0,
  };
}

/** Rule grade: anyone left behind or an unfinished run fails; otherwise time and queueing decide. */
export function ruleVerdict(m: SimulationMetrics): { grade: VerdictGrade; reason: string } {
  const v = verdictMeasures(m);
  if (!v.finished || v.unreachable > 0 || v.evacuated < v.people - v.unreachable) {
    return { grade: 'bad', reason: v.unreachable > 0 ? `${v.unreachable} people cannot reach an exit.` : 'The evacuation did not finish.' };
  }
  const t = v.evacuationSeconds ?? Infinity;
  if (t <= 60 && v.maxQueueShare <= 0.12) return { grade: 'great', reason: `Everyone out in ${t.toFixed(0)} s with short queues.` };
  if (t <= EGRESS_TARGET_S && v.maxQueueShare <= 0.25) return { grade: 'good', reason: `Everyone out in ${t.toFixed(0)} s, within the ${EGRESS_TARGET_S} s target.` };
  return { grade: 'poor', reason: t > EGRESS_TARGET_S ? `Everyone got out, but it took ${t.toFixed(0)} s.` : `Everyone got out, but queues reached ${Math.round(v.maxQueueShare * 100)}% of the crowd.` };
}
