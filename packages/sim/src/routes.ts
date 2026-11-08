/**
 * Escape routes for escape plans (PLAN.md §3 E, D73): from a point, the shortest walking route
 * to every exit along the navigation fields (walls respected, through the middle of openings).
 * The plan shows the best one as the primary route and the best through another exit as the
 * secondary.
 */
import { pointInPolygon, type EgressDocument, type Vec2 } from '@egress/core';
import { compileFloor, type CompiledFloor } from './compile.ts';
import { FREE_WALK_SPEED } from './fields.ts';

export interface EscapeRoute {
  exitId: string;
  distanceM: number;
  /** Walking time at the free walking speed, before any queueing. */
  seconds: number;
  path: Vec2[];
}

const cellCenter = (c: CompiledFloor, cell: number): Vec2 => {
  const { grid } = c;
  return { x: grid.origin.x + ((cell % grid.width) + 0.5) * grid.cellSizeM, y: grid.origin.y + (Math.floor(cell / grid.width) + 0.5) * grid.cellSizeM };
};

/** Drop points that lie on a straight line between their neighbours. */
function simplify(path: Vec2[]): Vec2[] {
  if (path.length < 3) return path;
  const out = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const a = out[out.length - 1], b = path[i], c = path[i + 1];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(cross) > 1e-6) out.push(b);
  }
  out.push(path[path.length - 1]);
  return out;
}

/** The navigable cell nearest to `p` inside `polygon` (a room), so "You are here" never sits in a wall. */
function startCell(c: CompiledFloor, p: Vec2, polygon?: Vec2[]): number {
  const direct = c.nav.cellAt(p.x, p.y);
  if (direct >= 0 && c.navigable[direct] && (!polygon || pointInPolygon(p, polygon))) return direct;
  let best = -1, bestD = Infinity;
  for (let i = 0; i < c.navigable.length; i++) {
    if (!c.navigable[i]) continue;
    const q = cellCenter(c, i);
    if (polygon && !pointInPolygon(q, polygon)) continue;
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Routes from `from` (optionally kept inside a room outline) to every reachable exit, shortest first. */
export function escapeRoutes(doc: EgressDocument, from: Vec2, room?: Vec2[], compiled: CompiledFloor = compileFloor(doc)): EscapeRoute[] {
  const start = startCell(compiled, from, room);
  if (start < 0) return [];
  const routes: EscapeRoute[] = [];
  compiled.exits.forEach((exit, e) => {
    const field = compiled.nav.fields[e];
    if (!Number.isFinite(field[start])) return;
    const cells = [start];
    for (let cell = start, guard = 0; guard < 20_000; guard++) {
      const next = compiled.nav.steepestNeighbor(e, cell);
      if (next < 0) break;
      cells.push(next);
      cell = next;
    }
    const path = simplify([cellCenter(compiled, start), ...cells.slice(1).map(c => cellCenter(compiled, c)), exit.center]);
    const distanceM = Math.round(field[start] * 10) / 10;
    routes.push({ exitId: exit.openingId, distanceM, seconds: Math.round(distanceM / FREE_WALK_SPEED), path });
  });
  return routes.sort((a, b) => a.distanceM - b.distanceM);
}
