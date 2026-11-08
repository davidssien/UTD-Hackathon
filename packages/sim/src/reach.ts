/**
 * Which exit each part of the building walks to, before any simulation runs. Every cell goes to
 * its nearest exit, or down the stair with the shortest route out. The load on an exit is its
 * share of the crowd, and people ÷ door flow estimates how long it takes to clear. The door width
 * matters as much as the area: a large area behind a wide door can clear before a small area
 * behind a narrow one. The live model also moves people away from long queues, so this is an
 * estimate; it ignores stair queues.
 */
import type { EgressDocument, ID, PopulationBrushStroke, ScalarField, Vec2 } from '@egress/core';
import { buildingRoutes } from './building.ts';
import { isSpawnable, paintWeights } from './paint.ts';

export interface ExitReach {
  openingId: ID;
  floorId: ID;
  center: Vec2;
  /** People per second through the door. */
  capacity: number;
  people: number;
  clearSeconds: number;
  /** The last exit to clear, when the building has more than one in use. */
  slowest: boolean;
}

export interface FloorReach {
  grid: ScalarField['grid'];
  /** Per cell: index into `exits`, or -1 outside the rooms or with no route out. */
  cells: Int16Array;
}

export interface BuildingReach {
  exits: ExitReach[];
  floors: Record<ID, FloorReach>;
}

export function exitReach(doc: EgressDocument, people: number, strokes: PopulationBrushStroke[] = []): BuildingReach {
  const routes = buildingRoutes(doc, new Set());
  const exits: ExitReach[] = [];
  const finalExit: number[][] = [];
  // Floors are bottom-up, so the exit a stair leads to is already known.
  for (const route of routes) {
    finalExit.push(route.destinations.map(dest => {
      if (dest.portal) {
        exits.push({ openingId: dest.id, floorId: route.floor.id, center: dest.center, capacity: dest.capacity, people: 0, clearSeconds: 0, slowest: false });
        return exits.length - 1;
      }
      const below = routes[dest.descent!.floor];
      let best = -1, bestCost = Infinity;
      below.destinations.forEach((d, e) => {
        const cost = below.nav.distanceAt(e, dest.descent!.bottom.x, dest.descent!.bottom.y) + d.onwardM;
        if (cost < bestCost) { bestCost = cost; best = e; }
      });
      return best < 0 ? -1 : finalExit[dest.descent!.floor][best];
    }));
  }

  const weight = new Float64Array(exits.length);
  const floors: Record<ID, FloorReach> = {};
  routes.forEach((route, f) => {
    const { compiled: c, nav, destinations } = route;
    const painted = strokes.length ? paintWeights(c, strokes) : null;
    const cells = new Int16Array(c.navigable.length).fill(-1);
    for (let i = 0; i < cells.length; i++) {
      if (!c.navigable[i] || c.room[i] < 0) continue;
      let best = -1, bestCost = Infinity;
      for (let k = 0; k < destinations.length; k++) {
        const cost = nav.fields[k][i] + destinations[k].onwardM;
        if (cost < bestCost) { bestCost = cost; best = k; }
      }
      if (best < 0) continue;
      cells[i] = finalExit[f][best];
      if (cells[i] >= 0 && isSpawnable(c, i)) weight[cells[i]] += c.walkable[i] * (painted ? painted[i] : 1);
    }
    floors[route.floor.id] = { grid: c.grid, cells };
  });

  const total = weight.reduce((sum, w) => sum + w, 0);
  let slowest = -1;
  exits.forEach((exit, e) => {
    exit.people = total > 0 ? people * weight[e] / total : 0;
    exit.clearSeconds = exit.people / Math.max(0.1, exit.capacity);
    if (exit.people > 0 && (slowest < 0 || exit.clearSeconds > exits[slowest].clearSeconds)) slowest = e;
  });
  if (slowest >= 0 && exits.filter(e => e.people > 0).length > 1) exits[slowest].slowest = true;
  return { exits, floors };
}
