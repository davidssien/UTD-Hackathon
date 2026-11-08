/**
 * Fire and smoke for hazard runs.
 *
 * Fire starts in the areas a user lassoes (`fireArea` elements, several allowed on any floor) or
 * around a pin (`fire`). It spreads by chance: once a second, every open cell next to burning
 * cells ignites with probability 1 − (1 − p)^k for k burning neighbours. The chances come from a
 * stream seeded by the run, so every viewer replays the same fire. Burning cells emit smoke and,
 * like small supply vents, hold positive pressure: the floor's steady airflow (wind through open
 * apertures, the building's HVAC vents and the fire itself, re-solved as the fire grows) carries
 * the smoke, which also spreads by diffusion; open exterior apertures vent it outside. None of this depends
 * on the crowd, so a viewer can recompute it for any replay tick from the run's inputs.
 *
 * Simplifications, stated so they are not mistaken for physics: each floor carries its own fire
 * and smoke with no exchange through stair shafts; concentration is normalized to [0, 1].
 */
import { createRng, DT_SECONDS, pointInPolygon, TICK_RATE_HZ, type EgressDocument, type Rng, type ScalarField, type SimulationScenario, type Vec2 } from '@egress/core';
import { solveAir, type WindFrom } from './airflow.ts';

export const HAZARD = {
  /** Chance per second that a burning neighbour ignites an open cell. */
  spreadChancePerS: 0.12,
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

type Element = NonNullable<SimulationScenario['elements']>[number];
type FireElement = Extract<Element, { kind: 'fire' | 'fireArea' }>;

export interface Hazard {
  readonly floorId: string;
  readonly grid: ScalarField['grid'];
  readonly burning: Uint8Array;
  /** Walking distance (m) to the nearest burning cell; Infinity when nothing burns or it is cut off. */
  readonly nearFire: Float32Array;
  readonly smoke: Float32Array;
  /** First tick anything burns on this floor. */
  readonly ignitionTick: number;
  tick: number;
  burningCount: number;
}

interface HazardState extends Hazard {
  doc: EgressDocument;
  wind: WindFrom;
  /** Burning-cell count the airflow was last solved with (fire is a pressure source), and that solve's pressure. */
  airBurning: number;
  pressure: Float64Array;
  openCells: number;
  open: Uint8Array;
  neighbours: Int32Array;
  outside: Uint8Array;
  faceE: Float32Array;
  faceN: Float32Array;
  delta: Float32Array;
  /** Cells each fire element sets alight, and when. */
  starts: { tick: number; cells: number[] }[];
  rng: Rng;
}

/** One hazard per floor that has fire, in order of first appearance. Empty without fire. */
export function createHazards(doc: EgressDocument, scenario: Pick<SimulationScenario, 'elements' | 'windFrom'> & { seed?: number }): Hazard[] {
  const fires = (scenario.elements ?? []).filter((e): e is FireElement => e.kind === 'fire' || e.kind === 'fireArea');
  const floorIds = [...new Set(fires.map(f => f.floorId))].filter(id => doc.floors.some(f => f.id === id));
  return floorIds.map((floorId, index) => {
    const air = solveAir(doc, floorId, (scenario.windFrom ?? 'west') as WindFrom);
    const { grid, navigable, neighbours } = air;
    const n = navigable.length, cell = grid.cellSizeM;
    const center = (i: number) => ({ x: grid.origin.x + ((i % grid.width) + 0.5) * cell, y: grid.origin.y + (Math.floor(i / grid.width) + 0.5) * cell });
    const starts = fires.filter(f => f.floorId === floorId).map(f => {
      const cells: number[] = [];
      for (let i = 0; i < n; i++) {
        if (!navigable[i]) continue;
        const c = center(i);
        if (f.kind === 'fireArea' ? pointInPolygon(c, f.polygon) : Math.hypot(c.x - f.position.x, c.y - f.position.y) <= Math.max(f.radiusM, cell)) cells.push(i);
      }
      return { tick: Math.round(f.startSeconds * TICK_RATE_HZ), cells };
    }).filter(s => s.cells.length);
    const faceE = new Float32Array(n), faceN = new Float32Array(n);
    setFaces(faceE, faceN, neighbours, air.x, air.y);
    const h: HazardState = {
      doc, wind: (scenario.windFrom ?? 'west') as WindFrom, airBurning: 0, pressure: air.pressure, openCells: navigable.reduce((s, v) => s + v, 0),
      floorId, grid, burning: new Uint8Array(n), nearFire: new Float32Array(n).fill(Infinity), smoke: new Float32Array(n),
      ignitionTick: starts.length ? Math.min(...starts.map(s => s.tick)) : Infinity, tick: 0, burningCount: 0,
      open: navigable, neighbours, outside: air.outside, faceE, faceN, delta: new Float32Array(n), starts,
      rng: createRng(((scenario.seed ?? 1) ^ 0x46495245) + index * 7919),
    };
    return h;
  }).filter(h => Number.isFinite(h.ignitionTick));
}

/** Advance fire and smoke by one simulation tick (fixed DT, deterministic). */
export function stepHazard(hazard: Hazard): void {
  const h = hazard as HazardState;
  const tick = h.tick++;
  let changed = false;
  for (const s of h.starts) if (s.tick === tick) for (const i of s.cells) if (!h.burning[i]) { h.burning[i] = 1; h.burningCount++; changed = true; }
  if (tick < h.ignitionTick) return;
  // Chance spread, once a second, from the burning set as it stood at the start of the second.
  if (tick > h.ignitionTick && (tick - h.ignitionTick) % TICK_RATE_HZ === 0) {
    const was = h.burning.slice();
    const p = HAZARD.spreadChancePerS;
    for (let i = 0; i < was.length; i++) {
      if (was[i] || !h.open[i]) continue;
      let k = 0;
      for (let d = 0; d < 4; d++) { const j = h.neighbours[i * 4 + d]; if (j >= 0 && was[j]) k++; }
      if (k && h.rng.next() < 1 - (1 - p) ** k) { h.burning[i] = 1; h.burningCount++; changed = true; }
    }
  }
  if (changed) {
    nearFireDistances(h);
    // The fire pushes air outward like a supply vent; re-solve the floor's airflow as it grows.
    if (h.burningCount > h.airBurning * 1.15 + 3) {
      h.airBurning = h.burningCount;
      // Warm-started from the last solve: ~1–2% velocity error at a fraction of a cold solve's cost.
      const air = solveAir(h.doc, h.floorId, h.wind, [], { burning: h.burning, guess: h.pressure, absTolerance: 1e-6 * h.openCells });
      h.pressure = air.pressure;
      setFaces(h.faceE, h.faceN, h.neighbours, air.x, air.y);
    }
  }
  stepSmoke(h);
}

/** Face velocities (m/s) on east and north faces, from the averaged cell pressure gradients. */
function setFaces(faceE: Float32Array, faceN: Float32Array, neighbours: Int32Array, x: Float32Array, y: Float32Array) {
  const speed = (v: number) => Math.max(-HAZARD.maxAirSpeed, Math.min(HAZARD.maxAirSpeed, v * HAZARD.airSpeed));
  faceE.fill(0); faceN.fill(0);
  for (let i = 0; i < faceE.length; i++) {
    const e = neighbours[i * 4], north = neighbours[i * 4 + 2];
    if (e >= 0) faceE[i] = speed((x[i] + x[e]) / 2);
    if (north >= 0) faceN[i] = speed((y[i] + y[north]) / 2);
  }
}

/** Run the hazard forward to `tick` (it cannot go back; make a new one to rewind). */
export function advanceHazard(h: Hazard, tick: number): void {
  while (h.tick < tick) stepHazard(h);
}

export function cellOf(h: Hazard, p: Vec2): number {
  const { origin, cellSizeM, width, height } = h.grid;
  const gx = Math.floor((p.x - origin.x) / cellSizeM), gy = Math.floor((p.y - origin.y) / cellSizeM);
  return gx < 0 || gy < 0 || gx >= width || gy >= height ? -1 : gy * width + gx;
}

/** Is `p` burning, or within `marginM` of the flames (walking distance), at the hazard's current tick? */
export function burningAt(h: Hazard, p: Vec2, marginM = 0): boolean {
  const i = cellOf(h, p);
  return i >= 0 && h.nearFire[i] <= marginM;
}

/** Smoke concentration as a field for the heatmap (NaN off the air domain). */
export function smokeField(h: Hazard): ScalarField {
  const open = (h as HazardState).open, values = new Float32Array(h.smoke.length);
  for (let i = 0; i < values.length; i++) values[i] = open[i] ? h.smoke[i] : NaN;
  return { fieldId: 'smoke.concentration', aggregation: 'instant', grid: h.grid, units: 'relative concentration', values };
}

/** Centres of the burning cells as x, y pairs, for drawing the flames. */
export function burningCells(h: Hazard): Float32Array {
  const out = new Float32Array(h.burningCount * 2), { origin, cellSizeM, width } = h.grid;
  let k = 0;
  for (let i = 0; i < h.burning.length && k < out.length; i++) {
    if (!h.burning[i]) continue;
    out[k++] = origin.x + ((i % width) + 0.5) * cellSizeM; out[k++] = origin.y + (Math.floor(i / width) + 0.5) * cellSizeM;
  }
  return out;
}

function nearFireDistances(h: HazardState) {
  const n = h.burning.length, queue = new Int32Array(n), cell = h.grid.cellSizeM;
  let head = 0, tail = 0;
  h.nearFire.fill(Infinity);
  for (let i = 0; i < n; i++) if (h.burning[i]) { h.nearFire[i] = 0; queue[tail++] = i; }
  while (head < tail) {
    const i = queue[head++];
    for (let d = 0; d < 4; d++) {
      const j = h.neighbours[i * 4 + d];
      if (j >= 0 && h.nearFire[j] === Infinity) { h.nearFire[j] = h.nearFire[i] + cell; queue[tail++] = j; }
    }
  }
}

function stepSmoke(h: HazardState) {
  const { smoke, delta, faceE, faceN, neighbours, outside, burning } = h;
  const dt = DT_SECONDS, dx = h.grid.cellSizeM;
  const k = HAZARD.diffusionM2PerS * dt / (dx * dx), a = dt / dx;
  delta.fill(0);
  for (let i = 0; i < smoke.length; i++) {
    if (burning[i]) delta[i] += HAZARD.sourcePerS * dt;
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
