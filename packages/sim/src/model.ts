/**
 * egress-pedestrian v0.1 (Plan.md §6, D13): discrete pedestrians, fixed 0.1 s
 * ticks, simplified social force, per-exit distance fields, and token-bucket
 * flow limits at doors and exits. Deterministic: seeded PRNG, stable index
 * order, no wall-clock or Math.random.
 *
 * This is an exploratory flow model, not certified evacuation physics.
 */
import {
  ACTOR_EXITED, ACTOR_MOVING, ACTOR_QUEUED, createRng, DomainError, DT_SECONDS, TICK_RATE_HZ,
  type ActorFrame, type BottleneckMetric, type EgressDocument, type SimulationMetrics, type SimulationScenario,
} from '@egress/core';
import { compileFloor, type CompiledFloor, type Portal } from './compile.ts';
import { FieldAccumulator } from './fields.ts';
import { isSpawnable, paintWeights } from './paint.ts';
import { ActorHash, closestOnSegment, segmentsIntersect } from './spatial.ts';

export const MODEL_ID = 'egress-pedestrian';
export const MODEL_VERSION = '0.1.0';

/** Starting people, reusable across layouts for controlled before/after comparisons. */
export interface InitialActors {
  x: number[];
  y: number[];
  r: number[];
  vPref: number[];
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
  replanTicks: 20,
  hysteresis: 0.9,
  /** Actors slower than this near a portal count as queued (m/s). */
  queueSpeed: 0.3,
  queueRadius: 3,
  /** Fields are sampled every N ticks (2 Hz). */
  fieldEvery: 5,
  spawnAttempts: 250,
} as const;

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
  readonly tokens: Float64Array;
  readonly portalOpen: Uint8Array;
  readonly allowedExit: Uint8Array;
  readonly throughput: Int32Array;
  readonly queueAtExit: Int32Array;
  readonly hash: ActorHash;
  readonly fields: FieldAccumulator;
  readonly maxTicks: number;
  maxQueue: number;
  lastExitTick: number;
  exited: number;
  unreachable: number;
  /** The people as spawned, for rerunning a candidate layout with the same population. */
  readonly initial: InitialActors;
  /** How many given initial actors had to be respawned because the layout changed under them. */
  readonly respawned: number;
}

// ── initialize ──────────────────────────────────────────────────────────────

export function initialize(input: FrozenSimulationInput): SimState {
  const compiled = compileFloor(input.document);
  const { scenario } = input;
  const n = scenario.population.count;
  const rng = createRng(scenario.population.seed);
  const { grid, walkable } = compiled;

  // Spawn cells: walkable interior, weighted by free fraction × painted relative density (spec §4.1).
  const painted = scenario.population.distribution === 'painted' && scenario.population.strokes.length > 0;
  const weights = painted ? paintWeights(compiled, scenario.population.strokes) : null;
  const cells: number[] = [];
  const cdf: number[] = [];
  let total = 0;
  for (let i = 0; i < walkable.length; i++) {
    if (!isSpawnable(compiled, i)) continue;
    const w = walkable[i] * (weights ? weights[i] : 1);
    if (w <= 0) continue;
    total += w;
    cells.push(i);
    cdf.push(total);
  }
  if (!cells.length) {
    throw new DomainError('POPULATION_INFEASIBLE', painted
      ? 'The painting leaves no space where people can start. Erase some of the zero-density paint.'
      : 'There is no walkable inside area to place people in. Close the building outline first.');
  }

  const x = new Float64Array(n), y = new Float64Array(n), r = new Float64Array(n), vPref = new Float64Array(n);
  const placed = new Map<number, number[]>();
  const key = (px: number, py: number) => Math.floor(px) * 100_003 + Math.floor(py);
  const given = input.initialActors && input.initialActors.x.length === n ? input.initialActors : null;
  let respawned = 0;
  const fits = (a: number, px: number, py: number) => {
    if (!clearOfWalls(compiled, px, py, r[a] + 0.02)) return false;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const b of placed.get(key(px + dx, py + dy)) ?? []) {
        if (Math.hypot(px - x[b], py - y[b]) < r[a] + r[b] + 0.02) return false;
      }
    }
    const cell = compiled.nav.cellAt(px, py);
    return cell >= 0 && compiled.navigable[cell] === 1 && compiled.room[cell] >= 0;
  };
  const place = (a: number, px: number, py: number) => {
    x[a] = px; y[a] = py;
    const k = key(px, py);
    placed.set(k, [...(placed.get(k) ?? []), a]);
  };
  for (let a = 0; a < n; a++) {
    r[a] = rng.range(PARAMS.radiusMin, PARAMS.radiusMax);
    vPref[a] = Math.min(PARAMS.speedMax, Math.max(PARAMS.speedMin, rng.normal(PARAMS.speedMean, PARAMS.speedSd)));
    let ok = false;
    if (given) {
      // Controlled comparison: reuse the baseline's people exactly where the geometry still allows it.
      r[a] = given.r[a];
      vPref[a] = given.vPref[a];
      if (fits(a, given.x[a], given.y[a])) { place(a, given.x[a], given.y[a]); ok = true; }
      else respawned++;
    }
    for (let attempt = 0; attempt < PARAMS.spawnAttempts && !ok; attempt++) {
      const pick = rng.next() * total;
      let lo = 0, hi = cdf.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < pick) lo = mid + 1; else hi = mid; }
      const cell = cells[lo];
      const cx = cell % grid.width, cy = (cell - cx) / grid.width;
      const px = grid.origin.x + (cx + rng.next()) * grid.cellSizeM, py = grid.origin.y + (cy + rng.next()) * grid.cellSizeM;
      if (!fits(a, px, py)) continue;
      place(a, px, py);
      ok = true;
    }
    if (!ok) {
      throw new DomainError('POPULATION_INFEASIBLE', `Only ${a} of ${n} people fit with the minimum spacing. Lower the head count or add floor space.`, { placed: a, requested: n });
    }
  }

  const blocked = new Set(scenario.goal.blockedExitIds);
  const allowedExit = new Uint8Array(compiled.exits.length);
  compiled.exits.forEach((e, i) => { allowedExit[i] = blocked.has(e.openingId) ? 0 : 1; });
  const portalOpen = new Uint8Array(compiled.portals.length);
  compiled.portals.forEach((p, i) => { portalOpen[i] = p.kind === 'exit' && blocked.has(p.openingId) ? 0 : 1; });

  const state: SimState = {
    runId: input.runId, compiled, scenario, tick: 0, n, x, y,
    vx: new Float64Array(n), vy: new Float64Array(n), r, vPref,
    exit: new Int32Array(n).fill(-1), flag: new Uint8Array(n), stuck: new Uint16Array(n), squeeze: new Uint16Array(n), reachable: new Uint8Array(n),
    tokens: new Float64Array(compiled.portals.length).fill(1), portalOpen, allowedExit,
    throughput: new Int32Array(compiled.exits.length), queueAtExit: new Int32Array(compiled.exits.length),
    hash: new ActorHash(grid, n), fields: new FieldAccumulator(compiled),
    maxTicks: Math.round(scenario.durationSeconds * TICK_RATE_HZ), maxQueue: 0, lastExitTick: 0, exited: 0, unreachable: 0,
    initial: { x: Array.from(x), y: Array.from(y), r: Array.from(r), vPref: Array.from(vPref) },
    respawned,
  };
  for (let a = 0; a < n; a++) {
    chooseExit(state, a, true);
    state.reachable[a] = state.exit[a] >= 0 ? 1 : 0;
    if (!state.reachable[a]) state.unreachable++;
  }
  sampleFields(state);
  return state;
}

function clearOfWalls(compiled: CompiledFloor, px: number, py: number, clearance: number): boolean {
  if (compiled.segments.insideSolid(px, py)) return false;
  for (const s of compiled.segments.near(px, py)) {
    if (closestOnSegment(px, py, compiled.segments.segments[s])[2] < clearance) return false;
  }
  return true;
}

function chooseExit(state: SimState, a: number, initial: boolean) {
  const { nav, exits } = state.compiled;
  let best = -1, bestCost = Infinity, currentCost = Infinity;
  for (let e = 0; e < exits.length; e++) {
    if (!state.allowedExit[e]) continue;
    const d = nav.distanceAt(e, state.x[a], state.y[a]);
    if (!Number.isFinite(d)) continue;
    const cost = d / state.vPref[a] + state.queueAtExit[e] / Math.max(0.1, exits[e].capacity);
    if (e === state.exit[a]) currentCost = cost;
    if (cost < bestCost || (cost === bestCost && e < best)) { bestCost = cost; best = e; }
  }
  if (initial || state.exit[a] < 0 || bestCost < currentCost * PARAMS.hysteresis || !Number.isFinite(currentCost)) state.exit[a] = best;
}

// ── step ────────────────────────────────────────────────────────────────────

export function step(state: SimState): void {
  const { n, x, y, vx, vy, r, vPref, flag, compiled } = state;
  const { nav, portals, exits, segments } = compiled;
  const dt = DT_SECONDS;
  state.hash.rebuild(x, y, i => flag[i] !== ACTOR_EXITED, n);

  for (let p = 0; p < portals.length; p++) {
    const cap = state.portalOpen[p] ? portals[p].capacity : 0;
    state.tokens[p] = Math.min(Math.max(1, cap * 0.5), state.tokens[p] + cap * dt);
  }
  if (state.tick % PARAMS.replanTicks === 0) for (let a = 0; a < n; a++) if (flag[a] !== ACTOR_EXITED && state.reachable[a]) chooseExit(state, a, false);
  state.queueAtExit.fill(0);

  for (let a = 0; a < n; a++) {
    if (flag[a] === ACTOR_EXITED) continue;
    const px = x[a], py = y[a];
    let ax = 0, ay = 0;
    if (state.squeeze[a] > 0) state.squeeze[a]--;
    else if (state.stuck[a] > PARAMS.squeezeAfter && nearPortal(portals, px, py)) state.squeeze[a] = PARAMS.squeezeTicks;
    const ra = contactRadius(state, a);

    // 1–2. Desired velocity from the chosen exit's distance field.
    const e = state.exit[a];
    if (e >= 0) {
      const exit = exits[e];
      const inGap = Math.abs((px - exit.center.x) * exit.along.x + (py - exit.center.y) * exit.along.y) < exit.widthM / 2 &&
        Math.abs((px - exit.center.x) * exit.normal.x + (py - exit.center.y) * exit.normal.y) < exit.depthM + 0.5;
      // In the last 1.5 m, aim at the middle of the opening so nobody wedges against a jamb.
      const rx = px - exit.center.x, ry = py - exit.center.y;
      const across = rx * exit.normal.x + ry * exit.normal.y;
      const close = !inGap && across < 0 && Math.hypot(rx, ry) < 1.5;
      const funnel = close ? normalized(exit.center.x + exit.normal.x * 0.4 - px, exit.center.y + exit.normal.y * 0.4 - py) : null;
      const dir = inGap ? exit.normal : funnel ?? nav.direction(e, px, py);
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
    state.hash.forNear(px, py, b => {
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
      if (state.tokens[p] >= 1) {
        state.tokens[p] -= 1;
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
      if (!segments.insideSolid(qx, qy) && !segments.crosses(nx, ny, qx, qy) && !crossesAnyPortal(compiled, nx, ny, qx, qy)) { nx = qx; ny = qy; }
    }
    x[a] = nx;
    y[a] = ny;

    if (leaving >= 0) {
      flag[a] = ACTOR_EXITED;
      vx[a] = 0; vy[a] = 0;
      state.throughput[leaving]++;
      state.exited++;
      state.lastExitTick = state.tick + 1;
      continue;
    }
    const slow = Math.hypot(vx[a], vy[a]) < PARAMS.queueSpeed;
    if (e >= 0 && (queued || slow) && Math.hypot(nx - exits[e].center.x, ny - exits[e].center.y) < PARAMS.queueRadius) state.queueAtExit[e]++;
    state.stuck[a] = slow && !queued ? Math.min(60000, state.stuck[a] + 1) : 0;
    flag[a] = queued || (slow && nearPortal(portals, nx, ny)) ? ACTOR_QUEUED : ACTOR_MOVING;
  }

  separateOverlaps(state);
  sweepExited(state);
  let queue = 0;
  for (let e = 0; e < exits.length; e++) queue = Math.max(queue, state.queueAtExit[e]);
  state.maxQueue = Math.max(state.maxQueue, queue);
  state.tick++;
  if (state.tick % PARAMS.fieldEvery === 0 || isComplete(state)) sampleFields(state);
}

function crossesPortal(p: Portal, ax: number, ay: number, bx: number, by: number): boolean {
  return segmentsIntersect(ax, ay, bx, by, p.a.x, p.a.y, p.b.x, p.b.y);
}

function validMove(c: CompiledFloor, ax: number, ay: number, bx: number, by: number): boolean {
  return !c.segments.insideSolid(bx, by) && !c.segments.crosses(ax, ay, bx, by);
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
  const { n, x, y, r, flag, compiled } = state;
  state.hash.rebuild(x, y, i => flag[i] !== ACTOR_EXITED, n);
  for (let a = 0; a < n; a++) {
    if (flag[a] === ACTOR_EXITED) continue;
    state.hash.forNear(x[a], y[a], b => {
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
  const { exits } = state.compiled;
  for (let a = 0; a < state.n; a++) {
    if (state.flag[a] === ACTOR_EXITED) continue;
    for (let e = 0; e < exits.length; e++) {
      const exit = exits[e];
      const rx = state.x[a] - exit.center.x, ry = state.y[a] - exit.center.y;
      const across = rx * exit.normal.x + ry * exit.normal.y;
      const along = rx * exit.along.x + ry * exit.along.y;
      if (across > 0 && across < 2 && Math.abs(along) <= exit.widthM / 2 + state.r[a]) {
        state.flag[a] = ACTOR_EXITED;
        state.vx[a] = 0;
        state.vy[a] = 0;
        state.throughput[e]++;
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
  state.fields.addSample(state.tick, state.n, state.x, state.y, speeds, a => state.flag[a] !== ACTOR_EXITED);
}

// ── outputs ─────────────────────────────────────────────────────────────────

export function isComplete(state: SimState): boolean {
  return state.exited + state.unreachable >= state.n || state.tick >= state.maxTicks;
}

export function frame(state: SimState): ActorFrame {
  const actorXY = new Float32Array(state.n * 2);
  for (let a = 0; a < state.n; a++) { actorXY[a * 2] = state.x[a]; actorXY[a * 2 + 1] = state.y[a]; }
  return { tick: state.tick, actorXY, actorFlags: state.flag.slice() };
}

export function metrics(state: SimState): SimulationMetrics {
  const { exits, portals } = state.compiled;
  const summary = state.fields.congestionSummary();
  const complete = isComplete(state);
  const allOut = state.exited + state.unreachable >= state.n;
  const bottlenecks: BottleneckMetric[] = state.fields.hotspots(5).map(h => {
    const near = portals
      .map(p => ({ p, d: Math.hypot(p.center.x - h.x, p.center.y - h.y) }))
      .sort((a, b) => a.d - b.d)[0];
    const where = near && near.d < 3 ? ` near the ${near.p.widthM.toFixed(1)} m ${near.p.kind} ${near.p.openingId}` : '';
    return {
      floorId: state.compiled.floorId,
      regionCenter: { x: round2(h.x), y: round2(h.y) },
      score: round3(h.score),
      observedAtTick: Math.max(0, h.peakTick),
      fieldId: 'people.congestion',
      description: `Average congestion ${h.score.toFixed(2)}${where}`,
    };
  });
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
    meanCongestion: round3(summary.mean),
    peakCongestion: round3(summary.peak),
    perExitThroughput: Object.fromEntries(exits.map((e, i) => [e.openingId, state.throughput[i]])),
    bottlenecks,
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
