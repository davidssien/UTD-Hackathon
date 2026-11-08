/**
 * egress-pedestrian v0.1 (docs/ARCHITECTURE.md §6, D13): discrete pedestrians, fixed 0.1 s
 * ticks, simplified social force, per-exit distance fields, and token-bucket
 * flow limits at doors and exits. Deterministic: seeded PRNG, stable index
 * order, no wall-clock or Math.random.
 *
 * This is an exploratory flow model, not certified evacuation physics.
 */
import {
  ACTOR_EXITED, ACTOR_MOVING, ACTOR_QUEUED, ACTOR_TRANSITIONING, floorsByLevel, createRng, DomainError, DT_SECONDS, TICK_RATE_HZ,
  type ActorFrame, type BottleneckMetric, type EgressDocument, type SimulationMetrics, type SimulationScenario,
} from '@egress/core';
import { compileFloor, type CompiledFloor, type Portal } from './compile.ts';
import { buildingRoutes, STAIR_SPEED_FACTOR, type FloorRoutes, type Descent } from './building.ts';
import { FieldAccumulator } from './fields.ts';
import { isSpawnable, paintWeights } from './paint.ts';
import { ActorHash, closestOnSegment, segmentsIntersect } from './spatial.ts';

export const MODEL_ID = 'egress-pedestrian';
export const MODEL_VERSION = '0.2.0';

/** Starting people, reusable across layouts for controlled before/after comparisons. */
export interface InitialActors {
  x: number[];
  y: number[];
  r: number[];
  vPref: number[];
  floorIds?: string[];
}

export interface FrozenSimulationInput {
  runId: string;
  document: EgressDocument;
  scenario: SimulationScenario;
  /** Reuse these people (same index = same person). Anyone whose spot is now blocked is respawned and counted. */
  initialActors?: InitialActors;
}

export const PARAMS = {
  radiusMin: 0.22,
  radiusMax: 0.25,
  speedMean: 1.34,
  speedSd: 0.26,
  speedMin: 0.8,
  speedMax: 1.8,
  /** Relaxation time toward the desired velocity (s). */
  tau: 0.5,
  /** Person–person repulsion strength (m/s²) and range (m). */
  socialA: 3.0,
  socialB: 0.25,
  socialRange: 1.2,
  /** Wall repulsion strength (m/s²) and range (m). */
  wallA: 4.0,
  wallB: 0.12,
  maxAccel: 6,
  /** Weight of repulsion from people behind you (anisotropy, 0..1). */
  anisotropy: 0.35,
  /** Ticks of near-standstill before an actor starts yielding to lower-index neighbours. */
  stuckTicks: 10,
  /** After this many stalled ticks next to an opening, a person turns sideways (smaller contact radius) for squeezeTicks. */
  squeezeAfter: 20,
  squeezeTicks: 60,
  squeezeRadius: 0.13,
  speedCapFactor: 1.4,
  // Exit choice v0.2 (PEOPLE_FLOW_MODEL §4.2, PLAN.md D79).
  attentionMedianS: 6,
  attentionSigma: 0.5,
  attentionMinS: 2,
  attentionMaxS: 15,
  waitWeightMin: 1.2,
  waitWeightMax: 1.8,
  patiencePerAttention: 6,
  patienceNoiseS: 5,
  patienceMinS: 20,
  patienceMaxS: 90,
  switchAbsS: 3,
  switchRel: 0.15,
  /** Share of the switching margin still required when patience has run out. */
  impatientMargin: 0.5,
  commitRadiusM: 4,
  /** How often the per-exit "people ahead" tables are rebuilt (ticks). */
  waitTableTicks: 10,
  /** Actors slower than this near a portal count as queued (m/s). */
  queueSpeed: 0.3,
  queueRadius: 3,
  /** Fields are sampled every N ticks (2 Hz). */
  fieldEvery: 5,
  spawnAttempts: 250,
  /** The flow counts as stabilized after this many ticks with no exits and mean speed below stableSpeed (Plan D38). */
  stableWindowTicks: 100,
  stableSpeed: 0.05,
} as const;

interface SimulationFloor extends FloorRoutes {
  hash: ActorHash;
  fields: FieldAccumulator;
  tokens: Float64Array;
  portalOpen: Uint8Array;
  waitTables: Float64Array[];
  throughput: Int32Array;
  queue: Int32Array;
  stairReady: Int32Array;
  started: number;
  stairDescents: number;
}
interface StairTrip {
  stair: Descent;
  startTick: number;
  ticks: number;
  fromX: number;
  fromY: number;
}

export interface SimState {
  readonly runId: string;
  readonly compiled: CompiledFloor;
  readonly scenario: SimulationScenario;
  tick: number;
  readonly n: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  readonly r: Float64Array;
  readonly vPref: Float64Array;
  readonly exit: Int32Array;
  readonly flag: Uint8Array;
  /** Consecutive ticks spent nearly still; drives deterministic yielding to break symmetric jams. */
  readonly stuck: Uint16Array;
  /** Ticks left of turning sideways to squeeze past a jam. */
  readonly squeeze: Uint16Array;
  readonly reachable: Uint8Array;
  /** Exit choice v0.2: per-person attention span (ticks), waiting weight, patience (s), time waited (s). */
  readonly attentionTicks: Int32Array;
  readonly waitWeight: Float64Array;
  readonly patience: Float64Array;
  readonly waited: Float64Array;
  readonly nextReplan: Int32Array;
  readonly cooldownUntil: Int32Array;
  /** The exit before the last switch, to count reversals (A→B→A). */
  readonly prevExit: Int32Array;
  switches: number;
  reversals: number;
  readonly floors: SimulationFloor[];
  readonly actorFloor: Uint16Array;
  readonly transit: (StairTrip | null)[];
  readonly elevation: Float32Array;
  readonly fields: FieldAccumulator;
  readonly maxTicks: number;
  maxQueue: number;
  lastExitTick: number;
  /** Last tick anything changed meaningfully (someone exited, or people were still moving). */
  lastProgressTick: number;
  exited: number;
  unreachable: number;
  /** The people as spawned, for rerunning a candidate layout with the same population. */
  readonly initial: InitialActors;
  /** How many given initial actors had to be respawned because the layout changed under them. */
  readonly respawned: number;
}

// ── initialize ──────────────────────────────────────────────────────────────

function spawnPopulation(floors: CompiledFloor[], population: SimulationScenario['population'], initialActors?: InitialActors) {
  const n = population.count;
  const rng = createRng(population.seed);


  // Spawn cells: walkable interior, weighted by free fraction × painted relative density (spec §4.1).
  const painted = population.distribution === 'painted' && population.strokes.length > 0;
  const cells: number[] = [], cellFloors: number[] = [], cdf: number[] = [];
  let total = 0;
  for (const [f, compiled] of floors.entries()) {
    const weights = painted ? paintWeights(compiled, population.strokes) : null;
    for (let i = 0; i < compiled.walkable.length; i++) {
      if (!isSpawnable(compiled, i)) continue;
      const w = compiled.walkable[i] * (weights ? weights[i] : 1);
      if (w <= 0) continue;
      total += w;
      cells.push(i); cellFloors.push(f); cdf.push(total);
    }
  }
  if (!cells.length) {
    throw new DomainError('POPULATION_INFEASIBLE', painted
      ? 'The painting leaves no space where people can start. Erase some of the zero-density paint.'
      : 'There is no walkable inside area to place people in. Close the building outline first.');
  }

  const x = new Float64Array(n), y = new Float64Array(n), r = new Float64Array(n), vPref = new Float64Array(n);
  const placed = floors.map(() => new Map<number, number[]>());
  const actorFloor = new Uint16Array(n);
  const key = (px: number, py: number) => Math.floor(px) * 100_003 + Math.floor(py);
  const given = initialActors?.x.length === n ? initialActors : null;
  let respawned = 0;
  const fits = (a: number, f: number, px: number, py: number) => {
    const compiled = floors[f];
    if (!clearOfWalls(compiled, px, py, r[a] + 0.02)) return false;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const b of placed[f].get(key(px + dx, py + dy)) ?? []) {
        if (Math.hypot(px - x[b], py - y[b]) < r[a] + r[b] + 0.02) return false;
      }
    }
    const cell = compiled.nav.cellAt(px, py);
    return cell >= 0 && isSpawnable(compiled, cell);
  };
  const place = (a: number, f: number, px: number, py: number) => {
    actorFloor[a] = f;
    x[a] = px; y[a] = py;
    const k = key(px, py);
    placed[f].set(k, [...(placed[f].get(k) ?? []), a]);
  };
  for (let a = 0; a < n; a++) {
    r[a] = rng.range(PARAMS.radiusMin, PARAMS.radiusMax);
    vPref[a] = Math.min(PARAMS.speedMax, Math.max(PARAMS.speedMin, rng.normal(PARAMS.speedMean, PARAMS.speedSd)));
    let ok = false;
    if (given) {
      // Controlled comparison: reuse the baseline's people exactly where the geometry still allows it.
      r[a] = given.r[a];
      vPref[a] = given.vPref[a];
      const f = given.floorIds ? floors.findIndex(floor => floor.floorId === given.floorIds![a]) : 0;
      if (f >= 0 && fits(a, f, given.x[a], given.y[a])) { place(a, f, given.x[a], given.y[a]); ok = true; }
      else respawned++;
    }
    for (let attempt = 0; attempt < PARAMS.spawnAttempts && !ok; attempt++) {
      const pick = rng.next() * total;
      let lo = 0, hi = cdf.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < pick) lo = mid + 1; else hi = mid; }
      const cell = cells[lo], f = cellFloors[lo], grid = floors[f].grid;
      const cx = cell % grid.width, cy = (cell - cx) / grid.width;
      const px = grid.origin.x + (cx + rng.next()) * grid.cellSizeM, py = grid.origin.y + (cy + rng.next()) * grid.cellSizeM;
      if (!fits(a, f, px, py)) continue;
      place(a, f, px, py);
      ok = true;
    }
    if (!ok) {
      throw new DomainError('POPULATION_INFEASIBLE', `Only ${a} of ${n} people fit with the minimum spacing. Lower the head count or add floor space.`, { placed: a, requested: n });
    }
  }

  return { x, y, r, vPref, respawned, actorFloor };
}

/** The largest crowd this seed and paint distribution can place, up to the control's limit. */
export function populationCapacity(doc: EgressDocument, population: SimulationScenario['population']): number {
  try {
    spawnPopulation(floorsByLevel(doc).map(f => compileFloor(doc, f.id)), population);
    return population.count;
  } catch (e) {
    if (e instanceof DomainError && e.code === 'POPULATION_INFEASIBLE') return Number(e.details?.placed ?? 0);
    throw e;
  }
}

export function initialize(input: FrozenSimulationInput): SimState {
  const { scenario } = input;
  const n = scenario.population.count;
  const blocked = new Set(scenario.goal.blockedExitIds);
  const floors: SimulationFloor[] = buildingRoutes(input.document, blocked).map(route => ({
    ...route, hash: new ActorHash(route.compiled.grid, n), fields: new FieldAccumulator(route.compiled),
    tokens: new Float64Array(route.compiled.portals.length).fill(1),
    portalOpen: Uint8Array.from(route.compiled.portals, p => p.kind === 'exit' && blocked.has(p.openingId) ? 0 : 1),
    waitTables: route.destinations.map(() => new Float64Array(0)), throughput: new Int32Array(route.compiled.exits.length),
    queue: new Int32Array(route.destinations.length), stairReady: new Int32Array(route.destinations.length), started: 0, stairDescents: 0,
  }));
  const compiled = floors[0].compiled;
  const { x, y, r, vPref, respawned, actorFloor } = spawnPopulation(floors.map(f => f.compiled), scenario.population, input.initialActors);

  for (const f of actorFloor) floors[f].started++;

  // Behaviour traits on their own random stream, so spawn positions match v0.1 and the same
  // person (same index, same seed) keeps the same traits across before/after comparisons.
  const traits = createRng((scenario.population.seed ^ 0x5bd1e995) >>> 0);
  const attentionTicks = new Int32Array(n), waitWeight = new Float64Array(n), patience = new Float64Array(n), nextReplan = new Int32Array(n);
  for (let a = 0; a < n; a++) {
    const attention = Math.min(PARAMS.attentionMaxS, Math.max(PARAMS.attentionMinS,
      Math.exp(Math.log(PARAMS.attentionMedianS) + PARAMS.attentionSigma * traits.normal(0, 1))));
    attentionTicks[a] = Math.round(attention * TICK_RATE_HZ);
    waitWeight[a] = traits.range(PARAMS.waitWeightMin, PARAMS.waitWeightMax);
    patience[a] = Math.min(PARAMS.patienceMaxS, Math.max(PARAMS.patienceMinS, PARAMS.patiencePerAttention * attention + traits.range(-PARAMS.patienceNoiseS, PARAMS.patienceNoiseS)));
    nextReplan[a] = Math.floor(traits.next() * attentionTicks[a]) + 1;
  }

  const state: SimState = {
    runId: input.runId, compiled, scenario, tick: 0, n, x, y,
    vx: new Float64Array(n), vy: new Float64Array(n), r, vPref,
    exit: new Int32Array(n).fill(-1), flag: new Uint8Array(n), stuck: new Uint16Array(n), squeeze: new Uint16Array(n), reachable: new Uint8Array(n),
    attentionTicks, waitWeight, patience, waited: new Float64Array(n), nextReplan, cooldownUntil: new Int32Array(n), prevExit: new Int32Array(n).fill(-1),
    floors, actorFloor, transit: Array(n).fill(null), elevation: Float32Array.from(actorFloor, f => floors[f].floor.elevationM),
    switches: 0, reversals: 0, fields: floors[0].fields,
    maxTicks: Math.round(scenario.durationSeconds * TICK_RATE_HZ), maxQueue: 0, lastExitTick: 0, lastProgressTick: 0, exited: 0, unreachable: 0,
    initial: { x: Array.from(x), y: Array.from(y), r: Array.from(r), vPref: Array.from(vPref), floorIds: Array.from(actorFloor, f => floors[f].floor.id) },
    respawned,
  };
  // Start: nearest exit, then one round of the full rule so the split accounts for everyone else.
  for (let a = 0; a < n; a++) {
    chooseExit(state, a, 'initial');
    state.reachable[a] = state.exit[a] >= 0 ? 1 : 0;
    if (!state.reachable[a]) state.unreachable++;
  }
  rebuildWaitTables(state);
  for (let a = 0; a < n; a++) if (state.reachable[a]) chooseExit(state, a, 'initial');
  rebuildWaitTables(state);
  sampleFields(state);
  return state;
}

/** Per exit, the sorted distances of the people heading there (for "people ahead of me"). */
function rebuildWaitTables(state: SimState) {
  const lists = state.floors.map(f => f.destinations.map((): number[] => []));
  for (let a = 0; a < state.n; a++) {
    const e = state.exit[a], f = state.actorFloor[a];
    if (e < 0 || state.flag[a] === ACTOR_EXITED || state.transit[a]) continue;
    const d = state.floors[f].nav.distanceAt(e, state.x[a], state.y[a]);
    if (Number.isFinite(d)) lists[f][e].push(d);
  }
  state.floors.forEach((f, i) => { f.waitTables = lists[i].map(l => Float64Array.from(l).sort()); });
}

/** How many people heading to exit `e` are closer to it than distance `d` (binary search). */
function peopleAhead(table: Float64Array, d: number): number {
  let lo = 0, hi = table.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (table[mid] < d) lo = mid + 1; else hi = mid; }
  return lo;
}

function clearOfWalls(compiled: CompiledFloor, px: number, py: number, clearance: number): boolean {
  if (compiled.segments.insideSolid(px, py)) return false;
  for (const s of compiled.segments.near(px, py)) {
    if (closestOnSegment(px, py, compiled.segments.segments[s])[2] < clearance) return false;
  }
  return true;
}

/**
 * Exit choice v0.2 (PEOPLE_FLOW_MODEL §4.2). 'initial' takes the cheapest exit outright;
 * 'replan' applies the commitment thresholds; 'impatient' (patience used up) switches to
 * anything cheaper.
 */
function chooseExit(state: SimState, a: number, mode: 'initial' | 'replan' | 'impatient') {
  const { nav, destinations, waitTables } = state.floors[state.actorFloor[a]];
  const current = state.exit[a];
  const frustration = Math.min(1, state.waited[a] / state.patience[a]);
  let best = -1, bestCost = Infinity, currentCost = Infinity, currentDistance = Infinity;
  for (let e = 0; e < destinations.length; e++) {
    const dest = destinations[e];
    if (!Number.isFinite(dest.onwardM)) continue;
    const d = nav.distanceAt(e, state.x[a], state.y[a]);
    if (!Number.isFinite(d)) continue;
    const wait = peopleAhead(waitTables[e], d) / Math.max(0.1, dest.capacity);
    const cost = (d + dest.onwardM) / state.vPref[a] + state.waitWeight[a] * wait * (e === current ? 1 + frustration : 1);
    if (e === current) { currentCost = cost; currentDistance = d; }
    if (cost < bestCost || (cost === bestCost && e < best)) { bestCost = cost; best = e; }
  }
  if (mode === 'initial' || current < 0 || !Number.isFinite(currentCost)) { state.exit[a] = best; return; }
  if (best === current || best < 0 || currentDistance < PARAMS.commitRadiusM || state.cooldownUntil[a] === 0x7fffffff) return;
  if (mode === 'replan' && state.tick < state.cooldownUntil[a]) return;
  // Going back to the exit you just left always needs the full margin; impatience halves it otherwise.
  const margin = Math.max(PARAMS.switchAbsS, PARAMS.switchRel * currentCost);
  const goingBack = best === state.prevExit[a];
  const threshold = goingBack ? margin : mode === 'impatient' ? margin * PARAMS.impatientMargin : margin * (1 - frustration);
  if (currentCost - bestCost <= threshold) return;
  if (goingBack) {
    state.reversals++;
    state.cooldownUntil[a] = 0x7fffffff; // after going back once, a person commits for good
  }
  state.prevExit[a] = current;
  state.exit[a] = best;
  state.switches++;
  state.waited[a] = 0;
  if (!goingBack) state.cooldownUntil[a] = state.tick + 2 * state.attentionTicks[a];
}

// ── step ────────────────────────────────────────────────────────────────────

export function step(state: SimState): void {
  const { n, x, y, vx, vy, vPref, flag } = state;
  const dt = DT_SECONDS;
  rebuildActorHashes(state);
  for (const f of state.floors) {
    f.compiled.portals.forEach((portal, i) => {
      const cap = f.portalOpen[i] ? portal.capacity : 0;
      f.tokens[i] = Math.min(Math.max(1, cap * 0.5), f.tokens[i] + cap * dt);
    });
    f.queue.fill(0);
  }
  // Exit choice v0.2: each person re-decides on their own attention clock; impatience forces a look.
  if (state.tick % PARAMS.waitTableTicks === 0) rebuildWaitTables(state);
  for (let a = 0; a < n; a++) {
    if (flag[a] === ACTOR_EXITED || state.transit[a] || !state.reachable[a]) continue;
    if (state.waited[a] >= state.patience[a]) {
      chooseExit(state, a, 'impatient');
      state.waited[a] = 0;
      state.nextReplan[a] = state.tick + state.attentionTicks[a];
    } else if (state.tick >= state.nextReplan[a]) {
      chooseExit(state, a, 'replan');
      state.nextReplan[a] = state.tick + state.attentionTicks[a];
    }
  }


  for (let a = 0; a < n; a++) {
    if (flag[a] === ACTOR_EXITED) continue;
    const floor = state.floors[state.actorFloor[a]], compiled = floor.compiled;
    const { segments, portals, exits } = compiled;
    const trip = state.transit[a];
    if (trip) { descend(state, a, trip); continue; }
    const px = x[a], py = y[a];
    let ax = 0, ay = 0;
    if (state.squeeze[a] > 0) state.squeeze[a]--;
    else if (state.stuck[a] > PARAMS.squeezeAfter && nearPortal(portals, px, py)) state.squeeze[a] = PARAMS.squeezeTicks;
    const ra = contactRadius(state, a);

    // 1–2. Desired velocity from the chosen exit's distance field.
    const e = state.exit[a];
    const dest = floor.destinations[e];
    if (dest) {
      let dir = floor.nav.direction(e, px, py);
      const exit = dest.portal;
      if (exit) {
        const rx = px - exit.center.x, ry = py - exit.center.y;
        const across = rx * exit.normal.x + ry * exit.normal.y;
        const inGap = Math.abs(rx * exit.along.x + ry * exit.along.y) < exit.widthM / 2 && Math.abs(across) < exit.depthM + 0.5;
        if (inGap) dir = exit.normal;
        else if (across < 0 && Math.hypot(rx, ry) < 1.5) dir = normalized(exit.center.x + exit.normal.x * 0.4 - px, exit.center.y + exit.normal.y * 0.4 - py) ?? dir;
      } else if (dest.descent) {
        const dx = dest.center.x - px, dy = dest.center.y - py, distance = Math.hypot(dx, dy);
        if (distance < 0.5 && !segments.crosses(px, py, dest.center.x, dest.center.y)) {
          vx[a] = 0; vy[a] = 0;
          if (state.tick < floor.stairReady[e]) { flag[a] = ACTOR_QUEUED; floor.queue[e]++; continue; }
          floor.stairReady[e] = state.tick + Math.ceil(TICK_RATE_HZ / dest.capacity);
          const ticks = Math.max(1, Math.ceil(dest.descent.length / (vPref[a] * STAIR_SPEED_FACTOR) * TICK_RATE_HZ));
          state.transit[a] = { stair: dest.descent, startTick: state.tick, ticks, fromX: px, fromY: py };
          flag[a] = ACTOR_TRANSITIONING;
          descend(state, a, state.transit[a]!);
          continue;
        }
        if (distance < 0.8 && !segments.crosses(px, py, dest.center.x, dest.center.y)) dir = normalized(dx, dy);
      }
      if (dir) {
        ax += (dir.x * vPref[a] - vx[a]) / PARAMS.tau;
        ay += (dir.y * vPref[a] - vy[a]) / PARAMS.tau;
      } else {
        ax -= vx[a] / PARAMS.tau;
        ay -= vy[a] / PARAMS.tau;
      }
    } else {
      ax -= vx[a] / PARAMS.tau;
      ay -= vy[a] / PARAMS.tau;
    }

    // 3. Repulsion from neighbours and walls.
    floor.hash.forNear(px, py, b => {
      if (b === a) return;
      let dx = px - x[b], dy = py - y[b];
      let d = Math.hypot(dx, dy);
      if (d > PARAMS.socialRange) return;
      if (d < 1e-6) { dx = b < a ? 1 : -1; dy = 0; d = 1e-6; }
      let f = PARAMS.socialA * Math.exp((ra + contactRadius(state, b) - d) / PARAMS.socialB);
      // Anisotropy: people behind push less than people ahead.
      const speed = Math.hypot(vx[a], vy[a]);
      if (speed > 0.05) {
        const cos = -(dx * vx[a] + dy * vy[a]) / (d * speed);
        f *= PARAMS.anisotropy + (1 - PARAMS.anisotropy) * (1 + cos) / 2;
      }
      // Symmetric jams (two people wedged in a doorway): the lower index goes first.
      if (state.stuck[a] > PARAMS.stuckTicks && b > a) f *= 0.2;
      ax += (f * dx) / d;
      ay += (f * dy) / d;
    });
    // Walls push from the single closest point only: edges meeting at a corner must not
    // double-count, or people stall at door jambs. Someone stalled near an opening ignores
    // wall push entirely (collision still keeps them out of the wall) so jams always clear.
    if (state.stuck[a] <= PARAMS.stuckTicks * 2 || !nearPortal(portals, px, py)) {
      let wx = 0, wy = 0, wd = Infinity;
      for (const s of segments.near(px, py)) {
        const [cx, cy, d] = closestOnSegment(px, py, segments.segments[s]);
        if (d < wd) { wd = d; wx = cx; wy = cy; }
      }
      if (wd < 0.6 && wd > 1e-6) {
        const f = PARAMS.wallA * Math.exp((ra - wd) / PARAMS.wallB);
        ax += (f * (px - wx)) / wd;
        ay += (f * (py - wy)) / wd;
      }
    }
    const acc = Math.hypot(ax, ay);
    if (acc > PARAMS.maxAccel) { ax *= PARAMS.maxAccel / acc; ay *= PARAMS.maxAccel / acc; }
    vx[a] += ax * dt;
    vy[a] += ay * dt;
    const cap = vPref[a] * PARAMS.speedCapFactor;
    const speed = Math.hypot(vx[a], vy[a]);
    if (speed > cap) { vx[a] *= cap / speed; vy[a] *= cap / speed; }

    let nx = px + vx[a] * dt, ny = py + vy[a] * dt;
    let queued = false, leaving = -1;

    // 5. Doors and exits: crossing a portal line costs a token.
    for (let p = 0; p < portals.length; p++) {
      const portal = portals[p];
      if (!crossesPortal(portal, px, py, nx, ny)) continue;
      if (floor.portalOpen[p] && floor.tokens[p] >= 1) {
        floor.tokens[p] -= 1;
        if (portal.kind === 'exit' && (nx - px) * portal.normal.x + (ny - py) * portal.normal.y > 0) leaving = exits.indexOf(portal);
      } else {
        nx = px; ny = py; vx[a] = 0; vy[a] = 0; queued = true;
      }
      break;
    }

    // 4. Never through walls: refuse moves that cross a wall edge or end inside one; try sliding along axes.
    if (leaving < 0 && (nx !== px || ny !== py) && !validMove(compiled, px, py, nx, ny)) {
      if (validMove(compiled, px, py, nx, py)) { ny = py; vy[a] = 0; }
      else if (validMove(compiled, px, py, px, ny)) { nx = px; vx[a] = 0; }
      else { nx = px; ny = py; vx[a] = 0; vy[a] = 0; }
    }
    // Push out of wall edges we overlap, unless that would put us inside a wall.
    for (const s of segments.near(nx, ny)) {
      const [cx, cy, d] = closestOnSegment(nx, ny, segments.segments[s]);
      if (d >= ra || d < 1e-9) continue;
      const qx = nx + ((nx - cx) / d) * (ra - d), qy = ny + ((ny - cy) / d) * (ra - d);
      if (validMove(compiled, nx, ny, qx, qy) && !crossesAnyPortal(compiled, nx, ny, qx, qy)) { nx = qx; ny = qy; }
    }
    x[a] = nx;
    y[a] = ny;

    if (leaving >= 0) {
      flag[a] = ACTOR_EXITED;
      vx[a] = 0; vy[a] = 0;
      floor.throughput[leaving]++;
      state.exited++;
      state.lastExitTick = state.tick + 1;
      continue;
    }
    const slow = Math.hypot(vx[a], vy[a]) < PARAMS.queueSpeed;
    // Patience runs down only while queuing for the chosen exit (same room), not while held at an inner door.
    if (slow && e >= 0) {
      const cell = floor.nav.cellAt(nx, ny), room = dest.room;
      if (room < 0 || (cell >= 0 && compiled.room[cell] === room)) state.waited[a] += dt;
    }
    if (dest && (queued || slow) && Math.hypot(nx - dest.center.x, ny - dest.center.y) < PARAMS.queueRadius) floor.queue[e]++;
    state.stuck[a] = slow && !queued ? Math.min(60000, state.stuck[a] + 1) : 0;
    flag[a] = queued || (slow && nearPortal(portals, nx, ny)) ? ACTOR_QUEUED : ACTOR_MOVING;
  }

  separateOverlaps(state);
  const exitedBefore = state.exited;
  sweepExited(state);
  // Stabilization (D38): progress = someone left, or the people inside are still moving.
  let active = 0, speedSum = 0;
  for (let a = 0; a < n; a++) if (flag[a] !== ACTOR_EXITED) { active++; speedSum += Math.hypot(vx[a], vy[a]); }
  if (state.exited > exitedBefore || active === 0 || state.transit.some(Boolean) || speedSum / active >= PARAMS.stableSpeed) state.lastProgressTick = state.tick + 1;
  let queue = 0;
  for (const f of state.floors) for (const count of f.queue) queue = Math.max(queue, count);
  state.maxQueue = Math.max(state.maxQueue, queue);
  state.tick++;
  if (state.tick % PARAMS.fieldEvery === 0 || isComplete(state)) sampleFields(state);
}

function rebuildActorHashes(state: SimState) {
  state.floors.forEach((floor, i) => floor.hash.rebuild(state.x, state.y,
    a => state.actorFloor[a] === i && state.flag[a] !== ACTOR_EXITED && !state.transit[a], state.n));
}

function descend(state: SimState, a: number, trip: StairTrip) {
  const t = Math.min(1, (state.tick + 1 - trip.startTick) / trip.ticks);
  const upper = state.floors[state.actorFloor[a]], lower = state.floors[trip.stair.floor];
  state.x[a] = trip.fromX + (trip.stair.bottom.x - trip.fromX) * t;
  state.y[a] = trip.fromY + (trip.stair.bottom.y - trip.fromY) * t;
  state.elevation[a] = upper.floor.elevationM + (lower.floor.elevationM - upper.floor.elevationM) * t;
  if (t < 1) return;
  upper.stairDescents++;
  state.actorFloor[a] = trip.stair.floor;
  state.transit[a] = null;
  state.flag[a] = ACTOR_MOVING;
  state.exit[a] = -1; state.prevExit[a] = -1; state.waited[a] = 0; state.cooldownUntil[a] = 0; state.stuck[a] = 0;
  chooseExit(state, a, 'initial');
}

function crossesPortal(p: Portal, ax: number, ay: number, bx: number, by: number): boolean {
  return segmentsIntersect(ax, ay, bx, by, p.a.x, p.a.y, p.b.x, p.b.y);
}

function validMove(c: CompiledFloor, ax: number, ay: number, bx: number, by: number): boolean {
  return (!c.restrictSurface || !!c.navigable[c.nav.cellAt(bx, by)]) && !c.segments.insideSolid(bx, by) && !c.segments.crosses(ax, ay, bx, by);
}

function crossesAnyPortal(c: CompiledFloor, ax: number, ay: number, bx: number, by: number): boolean {
  for (const p of c.portals) if (crossesPortal(p, ax, ay, bx, by)) return true;
  return false;
}

function nearPortal(portals: Portal[], x: number, y: number): boolean {
  for (const p of portals) if (Math.hypot(x - p.center.x, y - p.center.y) < PARAMS.queueRadius) return true;
  return false;
}

/** One deterministic relaxation pass so bodies do not overlap. */
function separateOverlaps(state: SimState) {
  const { n, x, y, flag } = state;
  rebuildActorHashes(state);
  for (let a = 0; a < n; a++) {
    if (flag[a] === ACTOR_EXITED || state.transit[a]) continue;
    const { compiled, hash } = state.floors[state.actorFloor[a]];
    hash.forNear(x[a], y[a], b => {
      if (b <= a) return;
      const dx = x[b] - x[a], dy = y[b] - y[a];
      const d = Math.hypot(dx, dy), min = contactRadius(state, a) + contactRadius(state, b);
      if (d >= min || d < 1e-9) return;
      const push = (min - d) / 2, ux = dx / d, uy = dy / d;
      const ax2 = x[a] - ux * push, ay2 = y[a] - uy * push, bx2 = x[b] + ux * push, by2 = y[b] + uy * push;
      // Separation may not carry anyone through a door or exit: that would bypass flow capacity.
      if (validMove(compiled, x[a], y[a], ax2, ay2) && !crossesAnyPortal(compiled, x[a], y[a], ax2, ay2)) { x[a] = ax2; y[a] = ay2; }
      if (validMove(compiled, x[b], y[b], bx2, by2) && !crossesAnyPortal(compiled, x[b], y[b], bx2, by2)) { x[b] = bx2; y[b] = by2; }
    });
  }
}

/**
 * Anyone standing past an exit line (within its span) has left, however they
 * got there — separation and wall push-out can nudge people through too.
 */
function sweepExited(state: SimState) {
  for (let a = 0; a < state.n; a++) {
    if (state.flag[a] === ACTOR_EXITED || state.transit[a]) continue;
    const floor = state.floors[state.actorFloor[a]], exits = floor.compiled.exits;
    for (let e = 0; e < exits.length; e++) {
      if (!Number.isFinite(floor.destinations[e].onwardM)) continue;
      const exit = exits[e];
      const rx = state.x[a] - exit.center.x, ry = state.y[a] - exit.center.y;
      const across = rx * exit.normal.x + ry * exit.normal.y;
      const along = rx * exit.along.x + ry * exit.along.y;
      if (across > 0 && across < 2 && Math.abs(along) <= exit.widthM / 2 + state.r[a]) {
        state.flag[a] = ACTOR_EXITED;
        state.vx[a] = 0;
        state.vy[a] = 0;
        floor.throughput[e]++;
        state.exited++;
        state.lastExitTick = state.tick + 1;
        break;
      }
    }
  }
}

function sampleFields(state: SimState) {
  const speeds = new Float64Array(state.n);
  for (let a = 0; a < state.n; a++) speeds[a] = Math.hypot(state.vx[a], state.vy[a]);
  state.floors.forEach((floor, i) => floor.fields.addSample(state.tick, state.n, state.x, state.y, speeds,
    a => state.actorFloor[a] === i && state.flag[a] !== ACTOR_EXITED && !state.transit[a]));
}

// ── outputs ─────────────────────────────────────────────────────────────────

export function isComplete(state: SimState): boolean {
  return endReason(state) !== null;
}

/** Why the run ended: everyone reachable is out, the flow stabilized (nothing changing), or the safety timeout. */
export function endReason(state: SimState): 'all-out' | 'stabilized' | 'timeout' | null {
  if (state.exited + state.unreachable >= state.n) return 'all-out';
  if (state.tick - state.lastProgressTick >= PARAMS.stableWindowTicks) return 'stabilized';
  if (state.tick >= state.maxTicks) return 'timeout';
  return null;
}

export function frame(state: SimState): ActorFrame {
  const actorXY = new Float32Array(state.n * 2);
  for (let a = 0; a < state.n; a++) { actorXY[a * 2] = state.x[a]; actorXY[a * 2 + 1] = state.y[a]; }
  return { tick: state.tick, actorXY, actorFlags: state.flag.slice(),
    ...(state.floors.length > 1 ? { actorFloor: state.actorFloor.slice(), actorElevation: state.elevation.slice() } : {}) };
}

export function metrics(state: SimState): SimulationMetrics {
  const summaries = state.floors.map(f => f.fields.congestionSummary());
  const occupied = summaries.reduce((n, s) => n + s.cells, 0);
  const mean = occupied ? summaries.reduce((n, s) => n + s.mean * s.cells, 0) / occupied : 0;
  const peak = Math.max(...summaries.map(s => s.peak));
  const complete = isComplete(state);
  const allOut = state.exited + state.unreachable >= state.n;
  const bottlenecks: BottleneckMetric[] = state.floors.flatMap(f => f.fields.hotspots(5).map(h => {
    const near = f.compiled.portals
      .map(p => ({ p, d: Math.hypot(p.center.x - h.x, p.center.y - h.y) }))
      .sort((a, b) => a.d - b.d)[0];
    const where = near && near.d < 3 ? ` near the ${near.p.widthM.toFixed(1)} m ${near.p.kind} ${near.p.openingId}` : '';
    return {
      floorId: f.floor.id,
      regionCenter: { x: round2(h.x), y: round2(h.y) },
      score: round3(h.score),
      observedAtTick: Math.max(0, h.peakTick),
      fieldId: 'people.congestion' as const,
      description: `Average congestion ${h.score.toFixed(2)}${where}`,
    };
  })).sort((a, b) => b.score - a.score).slice(0, 5);
  return {
    runId: state.runId,
    tick: state.tick,
    simulatedSeconds: state.tick / TICK_RATE_HZ,
    initialPeople: state.n,
    evacuatedPeople: state.exited,
    remainingPeople: state.n - state.exited,
    unreachablePeople: state.unreachable,
    evacuationTimeSeconds: allOut && state.exited > 0 ? state.lastExitTick / TICK_RATE_HZ : null,
    maxQueueLength: state.maxQueue,
    meanCongestion: round3(mean),
    peakCongestion: round3(peak),
    perExitThroughput: Object.fromEntries(state.floors.flatMap(f => f.compiled.exits.map((e, i) => [e.openingId, f.throughput[i]]))),
    ...(state.floors.length > 1 ? { perFloor: Object.fromEntries(state.floors.map(f => [f.floor.id, {
      started: f.started, exitedHere: f.throughput.reduce((sum, n) => sum + n, 0), stairDescents: f.stairDescents,
    }])) } : {}),
    bottlenecks,
    endReason: endReason(state) ?? undefined,
    exitSwitches: state.switches,
    exitReversals: state.reversals,
    complete,
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Body radius used for contacts; smaller while turning sideways to squeeze through. */
function contactRadius(state: SimState, a: number): number {
  return state.squeeze[a] > 0 ? Math.min(state.r[a], PARAMS.squeezeRadius) : state.r[a];
}

function normalized(x: number, y: number): { x: number; y: number } | null {
  const len = Math.hypot(x, y);
  return len < 1e-9 ? null : { x: x / len, y: y / len };
}
