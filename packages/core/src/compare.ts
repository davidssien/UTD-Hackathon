/**
 * Run comparison math shared by the agent, the runner and the UI clients.
 * Deltas are always candidate − baseline (negative = improvement for times,
 * queues and congestion).
 */
import type { ScalarField, SimulationMetrics } from './types.ts';

/** Evacuation time, or for runs that did not get everyone out, elapsed time + 10 s per person still inside. */
export const effectiveTime = (m: SimulationMetrics) => m.evacuationTimeSeconds ?? m.simulatedSeconds + 10 * m.remainingPeople;

const round = (v: number) => Math.round(v * 100) / 100;
const KEYS = ['evacuationTimeSeconds', 'maxQueueLength', 'peakCongestion', 'meanCongestion', 'evacuatedPeople', 'unreachablePeople'] as const;

export function metricsDelta(base: SimulationMetrics, cand: SimulationMetrics): Record<string, number> {
  const out: Record<string, number> = { effectiveTimeSeconds: round(effectiveTime(cand) - effectiveTime(base)) };
  for (const k of KEYS) {
    const a = base[k], b = cand[k];
    if (typeof a === 'number' && typeof b === 'number') out[k] = round(b - a);
  }
  if (base.evacuationTimeSeconds && cand.evacuationTimeSeconds) {
    out.evacuationTimePercent = round(((cand.evacuationTimeSeconds - base.evacuationTimeSeconds) / base.evacuationTimeSeconds) * 100);
  }
  return out;
}

/**
 * Cell-wise `candidate − baseline` on the baseline's grid. The candidate is
 * sampled at each baseline cell center (nearest cell), so layouts whose grids
 * differ slightly still compare. NaN where either side is not walkable.
 */
export function fieldDifference(baseline: ScalarField, candidate: ScalarField): ScalarField {
  const g = baseline.grid, h = candidate.grid;
  const values = new Float32Array(baseline.values.length);
  for (let cy = 0; cy < g.height; cy++) {
    for (let cx = 0; cx < g.width; cx++) {
      const i = cy * g.width + cx;
      const x = g.origin.x + (cx + 0.5) * g.cellSizeM, y = g.origin.y + (cy + 0.5) * g.cellSizeM;
      const hx = Math.floor((x - h.origin.x) / h.cellSizeM), hy = Math.floor((y - h.origin.y) / h.cellSizeM);
      const b = hx >= 0 && hy >= 0 && hx < h.width && hy < h.height ? candidate.values[hy * h.width + hx] : NaN;
      const a = baseline.values[i];
      values[i] = Number.isFinite(a) && Number.isFinite(b) ? b - a : NaN;
    }
  }
  return { fieldId: baseline.fieldId, aggregation: baseline.aggregation, grid: g, units: `Δ ${baseline.units}`, values };
}
