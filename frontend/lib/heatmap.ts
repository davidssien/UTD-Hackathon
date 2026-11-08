/** Heatmap data for the smooth heatmap shader (PLAN.md D71). Pure, so it can be unit tested. */
import type { ScalarField } from '@egress/core';

/** Field values in R and the walkable mask in G (NaN = wall), two floats per cell. */
export function encodeField(field: ScalarField): Float32Array {
  const v = field.values, out = new Float32Array(v.length * 2);
  for (let i = 0; i < v.length; i++) {
    const ok = Number.isFinite(v[i]);
    out[i * 2] = ok ? v[i] : 0;
    out[i * 2 + 1] = ok ? 1 : 0;
  }
  return out;
}

/** Colour scale: a fixed maximum for density/congestion; symmetric around 0 for difference maps. */
export function fieldScale(field: ScalarField, diverging: boolean, max: number): number {
  if (!diverging) return max;
  let scale = 1e-6;
  for (const x of field.values) if (Number.isFinite(x)) scale = Math.max(scale, Math.abs(x));
  return scale;
}
