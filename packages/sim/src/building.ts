/** A floor's destinations are its exterior exits and the top landings of usable down stairs.
 * Floors are solved bottom-up, so the cost of a stair includes the route after descent. */
import { floorsByLevel, stairGeometry, type EgressDocument, type Floor, type Vec2 } from '@egress/core';
import { compileFloor, type CompiledFloor, type Portal } from './compile.ts';
import { buildNavigation, type Navigation } from './nav.ts';

export interface Descent {
  floor: number;
  bottom: Vec2;
  top: Vec2;
  length: number;
  width: number;
}
export interface Destination {
  id: string;
  center: Vec2;
  capacity: number;
  room: number;
  onwardM: number;
  portal?: Portal;
  descent?: Descent;
}
export interface FloorRoutes {
  floor: Floor;
  compiled: CompiledFloor;
  nav: Navigation;
  destinations: Destination[];
}

/** Walking speed on stairs relative to the person's preferred walking speed. */
export const STAIR_SPEED_FACTOR = 0.55;

export function buildingRoutes(doc: EgressDocument, blocked: ReadonlySet<string>): FloorRoutes[] {
  const routes: FloorRoutes[] = [];
  for (const floor of floorsByLevel(doc)) {
    const c = compileFloor(doc, floor.id);
    const destinations: Destination[] = c.exits.map(portal => {
      const cell = c.nav.cellAt(portal.center.x - portal.normal.x * 0.4, portal.center.y - portal.normal.y * 0.4);
      return { id: portal.openingId, center: portal.center, capacity: portal.capacity, room: c.room[cell] ?? -1,
        onwardM: blocked.has(portal.openingId) ? Infinity : 0, portal };
    });
    const seeds = [...c.exitSeeds];
    for (const stair of doc.stairs.filter(s => s.toFloorId === floor.id)) {
      const index = routes.findIndex(r => r.floor.id === stair.floorId);
      const below = routes[index];
      if (!below) continue;
      const rise = floor.elevationM - below.floor.elevationM;
      const { top, bottom, width } = stairGeometry(stair, rise);
      const topCell = c.nav.cellAt(top.x, top.y), bottomCell = below.nav.cellAt(bottom.x, bottom.y);
      if (!c.navigable[topCell] || !below.compiled.navigable[bottomCell]) continue;
      let onward = Infinity;
      for (let e = 0; e < below.destinations.length; e++) {
        onward = Math.min(onward, below.nav.distanceAt(e, bottom.x, bottom.y) + below.destinations[e].onwardM);
      }
      if (!Number.isFinite(onward)) continue;
      const length = Math.hypot(top.x - bottom.x, top.y - bottom.y, rise);
      destinations.push({ id: stair.id, center: top, room: c.room[topCell], capacity: Math.max(0.3, width * 0.9),
        onwardM: length / STAIR_SPEED_FACTOR + onward, descent: { floor: index, top, bottom, length, width } });
      seeds.push([topCell]);
    }
    const nav = seeds.length === c.exits.length ? c.nav : buildNavigation(c.grid, c.navigable, seeds, c.blockedEdges, c.clearance);
    routes.push({ floor, compiled: c, destinations, nav });
  }
  return routes;
}
