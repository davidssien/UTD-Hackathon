/**
 * Static structural analysis for Edit mode (docs/ARCHITECTURE.md §5.2 "static geometry
 * analysis"): exit distance and route demand assuming everyone starts
 * uniformly spread out. It is a *potential bottleneck estimate*, not observed
 * congestion — no people are simulated.
 */
import type { ScalarField } from '@egress/core';
import type { CompiledFloor } from './compile.ts';

export type StructuralFieldId = 'people.exitDistance' | 'people.routeDemand';

const cache = new WeakMap<CompiledFloor, Partial<Record<StructuralFieldId, ScalarField>>>();

export function structuralField(compiled: CompiledFloor, id: StructuralFieldId): ScalarField {
  const entry = cache.get(compiled) ?? {};
  const hit = entry[id];
  if (hit) return hit;
  const field = id === 'people.exitDistance' ? exitDistance(compiled) : routeDemand(compiled);
  cache.set(compiled, { ...entry, [id]: field });
  return field;
}

/** Path distance (m) to the nearest exit; NaN where unreachable or not walkable. */
function exitDistance(c: CompiledFloor): ScalarField {
  const n = c.walkable.length;
  const values = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!c.navigable[i]) continue;
    let best = Infinity;
    for (const f of c.nav.fields) if (f[i] < best) best = f[i];
    if (Number.isFinite(best)) values[i] = best;
  }
  return { fieldId: 'people.exitDistance', aggregation: 'instant', grid: c.grid, units: 'm', values };
}

/**
 * Floor area (m²) whose shortest route to an exit passes through each cell:
 * every walkable cell sends its area downhill along the nearest exit's
 * distance field. High values = where uniform crowds would converge.
 */
function routeDemand(c: CompiledFloor): ScalarField {
  const n = c.walkable.length;
  const area = c.grid.cellSizeM * c.grid.cellSizeM;
  const demand = new Float32Array(n);
  const fields = c.nav.fields;
  for (let o = 0; o < n; o++) {
    if (!c.navigable[o] || c.room[o] < 0) continue;
    let exit = -1, best = Infinity;
    for (let e = 0; e < fields.length; e++) if (fields[e][o] < best) { best = fields[e][o]; exit = e; }
    if (exit < 0 || !Number.isFinite(best)) continue;
    const weight = c.walkable[o] * area;
    let cell = o;
    for (let guard = 0; guard < 4000; guard++) {
      demand[cell] += weight;
      if (fields[exit][cell] <= 0) break;
      const next = c.nav.steepestNeighbor(exit, cell);
      if (next < 0) break;
      cell = next;
    }
  }
  // Descent paths are one cell wide; two same-room 3×3 passes turn them into readable bands.
  const smoothed = smoothWithinRooms(c, smoothWithinRooms(c, demand));
  const values = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) if (c.navigable[i]) values[i] = smoothed[i];
  return { fieldId: 'people.routeDemand', aggregation: 'instant', grid: c.grid, units: 'm² of floor routed through', values };
}

function smoothWithinRooms(c: CompiledFloor, src: Float32Array): Float32Array {
  const { width, height } = c.grid;
  const out = new Float32Array(src.length);
  for (let cy = 0; cy < height; cy++) {
    for (let cx = 0; cx < width; cx++) {
      const i = cy * width + cx;
      if (!c.navigable[i]) continue;
      let sum = 0, count = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const j = y * width + x;
        if (!c.navigable[j] || c.room[j] !== c.room[i]) continue;
        sum += src[j];
        count++;
      }
      out[i] = sum / count;
    }
  }
  return out;
}
