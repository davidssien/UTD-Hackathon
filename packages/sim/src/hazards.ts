/**
 * Fire and smoke for hazard runs (docs/final-sprint/plan.md, next slice).
 *
 * One flame pin per run. The fire is the set of open cells whose walking distance from the pin
 * is within a radius that grows at FIRE_SPREAD_M_PER_S. Burning cells emit smoke, which moves on
 * the floor's steady airflow (wind through open apertures, plus HVAC supply vents) and spreads by
 * diffusion; open exterior apertures vent it outside. Everything here is independent of the
 * crowd, so a viewer can recompute the same smoke for any replay tick from the run's inputs.
 *
 * Simplifications, stated so they are not mistaken for physics: one floor (the fire's) carries
 * fire and smoke, with no exchange through stair shafts; concentration is normalized to [0, 1];
 * routes do not bend around flames, but an exit or stair inside the fire closes.
 */
import { DT_SECONDS, TICK_RATE_HZ, type EgressDocument, type ScalarField, type SimulationScenario, type Vec2 } from '@egress/core';
import { solveAir, type AirVent, type WindFrom } from './airflow.ts';

export const HAZARD = {
  /** Fire front speed along walkable paths (m/s) and its cap (m). */
  spreadMPerS: 0.05,
  maxRadiusM: 15,
  /** Smoke production per burning cell (concentration/s), turbulent diffusion (m²/s). */
  sourcePerS: 1.5,
  diffusionM2PerS: 0.15,
  /** Air speed per unit relative pressure gradient (m/s per 1/m), capped for stability. */
  airSpeed: 1.5,
  maxAirSpeed: 1.5,
  /** People give up an exit or stair with flames this close (m), and keep this far from flames when routing (m). */
  exitAvoidM: 2,
  routeAvoidM: 0.5,
  /** Exposure (concentration × s) that overcomes a person. */
  lethalDose: 20,
} as const;

type FireElement = Extract<NonNullable<SimulationScenario['elements']>[number], { kind: 'fire' }>;

export interface Hazard {
  readonly floorId: string;
  readonly fire: FireElement;
  readonly grid: ScalarField['grid'];
  /** Walking distance (m) from the flame pin through open cells; Infinity where unreachable. */
  readonly fireDistance: Float32Array;
  readonly smoke: Float32Array;
  readonly ignitionTick: number;
  tick: number;
}

/** The hazard of a scenario, or null when it places no fire. */
export function createHazard(doc: EgressDocument, scenario: Pick<SimulationScenario, 'elements' | 'windFrom'>): Hazard | null {
  const fire = scenario.elements?.find((e): e is FireElement => e.kind === 'fire');
  if (!fire || !doc.floors.some(f => f.id === fire.floorId)) return null;
  const vents: AirVent[] = (scenario.elements ?? []).filter(e => e.kind === 'vent' && e.floorId === fire.floorId)
    .map(e => ({ position: e.position, radiusM: e.radiusM }));
  const air = solveAir(doc, fire.floorId, (scenario.windFrom ?? 'west') as WindFrom, vents);
  const { grid, navigable, neighbours } = air;
  const n = navigable.length, cell = grid.cellSizeM;

  // Breadth-first walking distance from the pin's nearest open cell.
  const fireDistance = new Float32Array(n).fill(Infinity);
  const start = nearestOpen(grid, navigable, fire.position);
  if (start >= 0) {
    const queue = new Int32Array(n);
    let head = 0, tail = 0;
    fireDistance[start] = 0; queue[tail++] = start;
    while (head < tail) {
      const i = queue[head++];
      for (let d = 0; d < 4; d++) {
        const j = neighbours[i * 4 + d];
        if (j >= 0 && fireDistance[j] === Infinity) { fireDistance[j] = fireDistance[i] + cell; queue[tail++] = j; }
      }
    }
  }

  // Face velocities (m/s) on east and north faces, from the averaged cell gradients.
  const faceE = new Float32Array(n), faceN = new Float32Array(n);
  const speed = (v: number) => Math.max(-HAZARD.maxAirSpeed, Math.min(HAZARD.maxAirSpeed, v * HAZARD.airSpeed));
  for (let i = 0; i < n; i++) {
    const e = neighbours[i * 4], north = neighbours[i * 4 + 2];
    if (e >= 0) faceE[i] = speed((air.x[i] + air.x[e]) / 2);
    if (north >= 0) faceN[i] = speed((air.y[i] + air.y[north]) / 2);
  }
  const hazard: Hazard & { faceE: Float32Array; faceN: Float32Array; neighbours: Int32Array; outside: Uint8Array; delta: Float32Array } = {
    floorId: fire.floorId, fire, grid, fireDistance, smoke: new Float32Array(n),
    ignitionTick: Math.round(fire.startSeconds * TICK_RATE_HZ), tick: 0,
    faceE, faceN, neighbours, outside: air.outside, delta: new Float32Array(n),
  };
  return hazard;
}

/** Fire radius (m) at a tick; negative before ignition. */
export function fireRadius(h: Hazard, tick: number): number {
  if (tick < h.ignitionTick) return -1;
  return Math.min(HAZARD.maxRadiusM, h.fire.radiusM + HAZARD.spreadMPerS * (tick - h.ignitionTick) / TICK_RATE_HZ);
}

export function cellOf(h: Hazard, p: Vec2): number {
  const { origin, cellSizeM, width, height } = h.grid;
  const gx = Math.floor((p.x - origin.x) / cellSizeM), gy = Math.floor((p.y - origin.y) / cellSizeM);
  return gx < 0 || gy < 0 || gx >= width || gy >= height ? -1 : gy * width + gx;
}

export function burningAt(h: Hazard, p: Vec2, tick = h.tick, marginM = 0): boolean {
  const i = cellOf(h, p);
  return i >= 0 && h.fireDistance[i] <= fireRadius(h, tick) + marginM;
}

/** Advance fire and smoke by one simulation tick (fixed DT, deterministic). */
export function stepHazard(hazard: Hazard): void {
  const h = hazard as Hazard & { faceE: Float32Array; faceN: Float32Array; neighbours: Int32Array; outside: Uint8Array; delta: Float32Array };
  const r = fireRadius(h, h.tick);
  h.tick++;
  if (r < 0) return;
  const { smoke, delta, faceE, faceN, neighbours, outside, fireDistance } = h;
  const dt = DT_SECONDS, dx = h.grid.cellSizeM;
  const k = HAZARD.diffusionM2PerS * dt / (dx * dx), a = dt / dx;
  delta.fill(0);
  for (let i = 0; i < smoke.length; i++) {
    if (fireDistance[i] <= r) delta[i] += HAZARD.sourcePerS * dt;
    for (let d = 0; d < 4; d += 2) { // each face once: east (0) and north (2)
      const j = neighbours[i * 4 + d];
      if (j < 0) continue;
      const u = d === 0 ? faceE[i] : faceN[i];
      const flux = (u > 0 ? smoke[i] : smoke[j]) * u * a + k * (smoke[i] - smoke[j]);
      delta[i] -= flux; delta[j] += flux;
    }
  }
  for (let i = 0; i < smoke.length; i++) smoke[i] = outside[i] ? 0 : Math.min(1, Math.max(0, smoke[i] + delta[i]));
}

/** Run the hazard forward to `tick` (it cannot go back; make a new one to rewind). */
export function advanceHazard(h: Hazard, tick: number): void {
  while (h.tick < tick) stepHazard(h);
}

/** Smoke concentration as a field for the heatmap (NaN off the air domain). */
export function smokeField(h: Hazard): ScalarField {
  const values = new Float32Array(h.smoke.length);
  for (let i = 0; i < values.length; i++) values[i] = Number.isFinite(h.fireDistance[i]) || h.smoke[i] > 0 ? h.smoke[i] : NaN;
  return { fieldId: 'smoke.concentration', aggregation: 'instant', grid: h.grid, units: 'relative concentration', values };
}

function nearestOpen(grid: ScalarField['grid'], navigable: Uint8Array, p: Vec2): number {
  let best = -1, bestD = 1.5;
  for (let i = 0; i < navigable.length; i++) {
    if (!navigable[i]) continue;
    const cx = grid.origin.x + ((i % grid.width) + 0.5) * grid.cellSizeM, cy = grid.origin.y + (Math.floor(i / grid.width) + 0.5) * grid.cellSizeM;
    const d = Math.hypot(cx - p.x, cy - p.y);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}
