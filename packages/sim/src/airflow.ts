/** Steady planar cross-ventilation under an assumed exterior wind. Open exterior apertures
 * prescribe relative pressure. Interior openings connect rooms. Sealed boundaries carry
 * zero flux. The pressure gradient gives a relative flow vector for each grid cell. */
import { topology, type EgressDocument, type ScalarField, type Vec2 } from '@egress/core';
import { compileFloor } from './compile.ts';

export const WIND_FROM = {
  west: { x: 1, y: 0 }, north: { x: 0, y: -1 }, east: { x: -1, y: 0 }, south: { x: 0, y: 1 },
} satisfies Record<string, Vec2>;
export type WindFrom = keyof typeof WIND_FROM;

export interface FloorAirflow {
  magnitude: ScalarField;
  /** Plan coordinates, +x east and +y north. Values are in relative pressure units per metre. */
  x: Float32Array;
  y: Float32Array;
  peak: number;
  exteriorOpenings: number;
}

function airDomain(doc: EgressDocument, floorId: string) {
  const topo = topology(doc);
  const isRoom = (id: string) => (topo.faceById.get(id)?.area ?? 0) > 0;
  // Reuse the wall-cut grid with every open aperture, including windows. This derived
  // document is used only for air, so opening a window never makes it a pedestrian exit.
  return compileFloor({ ...doc, openings: doc.openings.map(o => {
    if (o.floorId !== floorId || o.state === 'closed') return o;
    const sides = topo.wallSides.get(o.wallId);
    const exterior = sides && isRoom(sides.left) !== isRoom(sides.right);
    return { ...o, openingKind: exterior ? 'exit' : 'door' };
  }) }, floorId);
}

export function floorAirflow(doc: EgressDocument, floorId: string, from: WindFrom = 'west'): FloorAirflow {
  const c = airDomain(doc, floorId);
  const { grid, navigable, blockedEdges } = c;
  const { width, height, cellSizeM } = grid;
  const n = navigable.length;
  const neighbours = new Int32Array(n * 4).fill(-1), degree = new Uint8Array(n);
  const pressure = new Float64Array(n), fixed = new Uint8Array(n);
  const wind = WIND_FROM[from];
  for (let e = 0; e < c.exits.length; e++) {
    const normal = c.exits[e].normal;
    for (const i of c.exitSeeds[e]) {
      fixed[i] = 1;
      pressure[i] = -(normal.x * wind.x + normal.y * wind.y);
    }
  }
  const offsets = [1, -1, width, -width];
  for (let i = 0; i < n; i++) {
    if (!navigable[i]) continue;
    const col = i % width;
    for (let d = 0; d < 4; d++) {
      const j = i + offsets[d];
      if ((d === 0 && col === width - 1) || (d === 1 && col === 0) || j < 0 || j >= n) continue;
      if (!navigable[j] || (blockedEdges[i] & (1 << d))) continue;
      neighbours[i * 4 + d] = j;
      degree[i]++;
    }
  }

  // Components with fewer than two distinct boundary pressures are exactly stagnant.
  const seen = new Uint8Array(n), queue = new Int32Array(n), free: number[] = [];
  for (let start = 0; start < n; start++) {
    if (!navigable[start] || seen[start]) continue;
    let size = 1, low = Infinity, high = -Infinity;
    queue[0] = start;
    seen[start] = 1;
    for (let k = 0; k < size; k++) {
      const i = queue[k];
      if (fixed[i]) { low = Math.min(low, pressure[i]); high = Math.max(high, pressure[i]); }
      for (let d = 0; d < 4; d++) {
        const j = neighbours[i * 4 + d];
        if (j >= 0 && !seen[j]) { queue[size++] = j; seen[j] = 1; }
      }
    }
    for (let k = 0; k < size; k++) {
      const i = queue[k];
      if (fixed[i]) continue;
      if (high - low > 1e-8) free.push(i);
      else pressure[i] = Number.isFinite(low) ? low : 0;
    }
  }

  // Conjugate gradient on the symmetric grid Laplacian with fixed aperture pressures.
  const residual = new Float64Array(n), direction = new Float64Array(n), product = new Float64Array(n);
  const laplacian = (v: Float64Array, i: number) => {
    let value = degree[i] * v[i];
    for (let d = 0; d < 4; d++) {
      const j = neighbours[i * 4 + d];
      if (j >= 0) value -= v[j];
    }
    return value;
  };
  let norm = 0;
  for (const i of free) {
    direction[i] = residual[i] = -laplacian(pressure, i);
    norm += residual[i] ** 2;
  }
  const tolerance = norm * 1e-12;
  const maxIterations = Math.min(1400, Math.max(100, 7 * (width + height)));
  for (let iter = 0; iter < maxIterations && norm > tolerance; iter++) {
    let denom = 0;
    for (const i of free) { product[i] = laplacian(direction, i); denom += direction[i] * product[i]; }
    if (denom <= 0) break;
    const step = norm / denom;
    let nextNorm = 0;
    for (const i of free) {
      pressure[i] += step * direction[i];
      residual[i] -= step * product[i];
      nextNorm += residual[i] ** 2;
    }
    const beta = nextNorm / norm;
    for (const i of free) direction[i] = residual[i] + beta * direction[i];
    norm = nextNorm;
  }

  const x = new Float32Array(n), y = new Float32Array(n), values = new Float32Array(n).fill(NaN);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    if (!navigable[i]) continue;
    const flux = (d: number) => {
      const j = neighbours[i * 4 + d];
      return j >= 0 ? (pressure[i] - pressure[j]) / cellSizeM : 0;
    };
    x[i] = (flux(0) - flux(1)) / 2;
    y[i] = (flux(2) - flux(3)) / 2;
    values[i] = Math.hypot(x[i], y[i]);
    peak = Math.max(peak, values[i]);
  }
  return { magnitude: { grid, fieldId: 'air.flowMagnitude', aggregation: 'instant', units: 'relative pressure/m', values },
    x, y, peak, exteriorOpenings: c.exitSeeds.filter(seeds => seeds.length).length };
}

