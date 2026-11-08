/**
 * Grid compiler (Plan.md §6 "Compile"). Turns an EgressDocument into the
 * 0.25 m simulation grid: walkable fractions, room ids, portals, collision
 * geometry and per-exit distance fields. Pure and deterministic; cache by
 * layoutHash.
 */
import {
  CELL_SIZE_M, deriveLayout, isPassable, layoutHash, openingSegment, pointInPolygon, topology, wallGeometry,
  type EgressDocument, type GridDefinition, type ID, type Opening, type Vec2,
} from '@egress/core';
import { buildNavigation, type Navigation } from './nav.ts';
import { closestOnSegment, SegmentIndex, type Segment } from './spatial.ts';

/** Flow capacity per meter of clear width (persons / m / s), the usual planning figure. */
export const FLOW_PER_METER = 1.3;

export interface Portal {
  openingId: ID;
  kind: 'door' | 'exit';
  a: Vec2;
  b: Vec2;
  center: Vec2;
  /** Unit vector along a→b. */
  along: Vec2;
  /** Unit normal; for exits it points outside. */
  normal: Vec2;
  widthM: number;
  /** Persons per second allowed through. */
  capacity: number;
  /** Half of the wall thickness: how far the gap extends on each side of the line. */
  depthM: number;
}

export interface CompiledFloor {
  layoutHash: string;
  floorId: ID;
  grid: GridDefinition;
  /** Free fraction of each cell in [0,1] (4×4 supersampled against wall polygons). */
  walkable: Float32Array;
  /** Room index per cell (-1 outside every room). Smoothing never crosses rooms. */
  room: Int32Array;
  /** 1 where people may stand or walk: walkable interior cells plus exit gaps. */
  navigable: Uint8Array;
  portals: Portal[];
  exits: Portal[];
  /** Solid outlines (closed doors and windows included) for collision. */
  solids: Vec2[][];
  segments: SegmentIndex;
  nav: Navigation;
  roomCount: number;
}

const cache = new Map<string, CompiledFloor>();

export function compileFloor(doc: EgressDocument, floorId: ID = doc.floors[0]?.id ?? ''): CompiledFloor {
  const hash = layoutHash(doc);
  const key = `${hash}:${floorId}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const floorDoc: EgressDocument = {
    ...doc,
    vertices: doc.vertices.filter(v => v.floorId === floorId),
    walls: doc.walls.filter(w => w.floorId === floorId),
    openings: doc.openings.filter(o => o.floorId === floorId),
  };
  const walls = wallGeometry(floorDoc, { cut: isPassable });
  const solids = [...walls.pieces.map(p => p.polygon), ...walls.hubs.map(h => h.polygon)];
  const topo = topology(floorDoc);
  const rooms = topo.rooms;

  // Grid over everything solid, plus a 1 m margin.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of solids) for (const p of poly) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 1; maxY = 1; }
  const cell = CELL_SIZE_M;
  const origin = { x: Math.floor((minX - 1) / cell) * cell, y: Math.floor((minY - 1) / cell) * cell };
  const width = Math.ceil((maxX + 1 - origin.x) / cell), height = Math.ceil((maxY + 1 - origin.y) / cell);
  const grid: GridDefinition = { floorId, origin, cellSizeM: cell, width, height };
  const n = width * height;

  // Walkable fraction: 4×4 samples per cell, each polygon only touches its bounding box.
  const SS = 4;
  const solidSamples = new Uint8Array(n * SS * SS);
  const sampleW = width * SS;
  for (const poly of solids) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of poly) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const sx0 = Math.max(0, Math.floor(((x0 - origin.x) / cell) * SS)), sx1 = Math.min(sampleW - 1, Math.ceil(((x1 - origin.x) / cell) * SS));
    const sy0 = Math.max(0, Math.floor(((y0 - origin.y) / cell) * SS)), sy1 = Math.min(height * SS - 1, Math.ceil(((y1 - origin.y) / cell) * SS));
    for (let sy = sy0; sy <= sy1; sy++) {
      for (let sx = sx0; sx <= sx1; sx++) {
        const p = { x: origin.x + ((sx + 0.5) / SS) * cell, y: origin.y + ((sy + 0.5) / SS) * cell };
        if (pointInPolygon(p, poly)) solidSamples[sy * sampleW + sx] = 1;
      }
    }
  }
  const walkable = new Float32Array(n);
  for (let cy = 0; cy < height; cy++) {
    for (let cx = 0; cx < width; cx++) {
      let solid = 0;
      for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) solid += solidSamples[(cy * SS + j) * sampleW + cx * SS + i];
      walkable[cy * width + cx] = 1 - solid / (SS * SS);
    }
  }

  // Room id per cell (by cell center), scanning each room's bounding box only.
  const room = new Int32Array(n).fill(-1);
  rooms.forEach((r, index) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of r.polygon) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const cx0 = Math.max(0, Math.floor((x0 - origin.x) / cell)), cx1 = Math.min(width - 1, Math.floor((x1 - origin.x) / cell));
    const cy0 = Math.max(0, Math.floor((y0 - origin.y) / cell)), cy1 = Math.min(height - 1, Math.floor((y1 - origin.y) / cell));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      const i = cy * width + cx;
      // Smaller rooms win for nested rooms: rooms are visited in topology order, so only fill unclaimed cells.
      if (room[i] === -1 && pointInPolygon({ x: origin.x + (cx + 0.5) * cell, y: origin.y + (cy + 0.5) * cell }, r.polygon)) room[i] = index;
    }
  });

  // Portals: open doors and exits.
  const isRoomFace = (faceId: string) => (topo.faceById.get(faceId)?.area ?? 0) > 1e-6;
  const portals: Portal[] = [];
  for (const o of floorDoc.openings) {
    if (!isPassable(o)) continue;
    const seg = openingSegment(floorDoc, o);
    const wall = floorDoc.walls.find(w => w.id === o.wallId);
    if (!seg || !wall) continue;
    let normal = seg.normal;
    if (o.openingKind === 'exit') {
      const sides = topo.wallSides.get(wall.id);
      // seg.normal points to the wall's left; flip it if the left side is a room.
      if (sides && isRoomFace(sides.left) && !isRoomFace(sides.right)) normal = { x: -normal.x, y: -normal.y };
    }
    portals.push(makePortal(o, seg.a, seg.b, normal, wall.thicknessM / 2));
  }
  const exits = portals.filter(p => p.kind === 'exit');

  // Collision segments: every edge of every solid polygon.
  const segments: Segment[] = [];
  for (const poly of solids) for (let i = 0; i < poly.length; i++) segments.push({ a: poly[i], b: poly[(i + 1) % poly.length] });
  const segmentIndex = new SegmentIndex(grid, segments, solids);
  const center = (i: number) => {
    const cx = i % width, cy = (i - cx) / width;
    return { x: origin.x + (cx + 0.5) * cell, y: origin.y + (cy + 0.5) * cell };
  };

  // Navigable: free enough, center not inside a wall, and inside a room — or inside an exit gap.
  const navigable = new Uint8Array(n);
  const freeCenter = (i: number) => { const c = center(i); return !segmentIndex.insideSolid(c.x, c.y); };
  for (let i = 0; i < n; i++) navigable[i] = walkable[i] >= 0.3 && room[i] >= 0 && freeCenter(i) ? 1 : 0;
  for (const e of exits) forEachCellInGap(grid, e, i => { if (walkable[i] >= 0.3 && freeCenter(i)) navigable[i] = 1; });

  // Walls are thinner than a cell, so cells alone cannot separate rooms: block every
  // step between cell centers that crosses a wall edge.
  const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1];
  const blockedEdges = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!navigable[i]) continue;
    const cx = i % width, cy = (i - cx) / width, a = center(i);
    for (let k = 0; k < 8; k++) {
      const x = cx + DX[k], y = cy + DY[k];
      if (x < 0 || y < 0 || x >= width || y >= height || !navigable[y * width + x]) continue;
      const b = center(y * width + x);
      if (segmentIndex.crosses(a.x, a.y, b.x, b.y)) blockedEdges[i] |= 1 << k;
    }
  }

  // Seed each exit's field with the gap cells on its outer half, so paths run through the opening.
  const seeds = exits.map(e => {
    const list: number[] = [];
    forEachCellInGap(grid, e, i => {
      if (!navigable[i]) return;
      const cx = i % width, cy = (i - cx) / width;
      const rx = origin.x + (cx + 0.5) * cell - e.center.x, ry = origin.y + (cy + 0.5) * cell - e.center.y;
      if (rx * e.normal.x + ry * e.normal.y >= 0) list.push(i);
    });
    return list;
  });
  // Distance from each cell center to the nearest wall edge (capped), for clearance-aware routing.
  const clearance = new Float32Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    if (!navigable[i]) continue;
    const c = center(i);
    for (const s of segmentIndex.near(c.x, c.y)) {
      const seg = segments[s];
      const d = closestOnSegment(c.x, c.y, seg)[2];
      if (d < clearance[i]) clearance[i] = d;
    }
  }
  const nav = buildNavigation(grid, navigable, seeds, blockedEdges, clearance);
  const compiled: CompiledFloor = {
    layoutHash: hash, floorId, grid, walkable, room, navigable, portals, exits, solids, segments: segmentIndex, nav, roomCount: rooms.length,
  };
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  cache.set(key, compiled);
  return compiled;
}

function makePortal(o: Opening, a: Vec2, b: Vec2, normal: Vec2, depthM: number): Portal {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  return {
    openingId: o.id,
    kind: o.openingKind === 'exit' ? 'exit' : 'door',
    a, b,
    center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    along: { x: (b.x - a.x) / len, y: (b.y - a.y) / len },
    normal,
    widthM: o.widthM,
    capacity: FLOW_PER_METER * o.widthM,
    depthM,
  };
}

/** Cells whose centers lie in the opening's gap (its width × wall thickness, plus one cell outward for exits). */
export function forEachCellInGap(grid: GridDefinition, portal: Portal, fn: (index: number) => void): void {
  const { origin, cellSizeM: cell, width, height } = grid;
  const reach = portal.depthM + (portal.kind === 'exit' ? cell * 1.5 : 0);
  const corners = [-1, 1].flatMap(s => [portal.a, portal.b].map(p => ({ x: p.x + portal.normal.x * reach * s, y: p.y + portal.normal.y * reach * s })));
  const xs = corners.map(c => c.x), ys = corners.map(c => c.y);
  const cx0 = Math.max(0, Math.floor((Math.min(...xs) - origin.x) / cell)), cx1 = Math.min(width - 1, Math.floor((Math.max(...xs) - origin.x) / cell));
  const cy0 = Math.max(0, Math.floor((Math.min(...ys) - origin.y) / cell)), cy1 = Math.min(height - 1, Math.floor((Math.max(...ys) - origin.y) / cell));
  for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
    const p = { x: origin.x + (cx + 0.5) * cell, y: origin.y + (cy + 0.5) * cell };
    const rx = p.x - portal.center.x, ry = p.y - portal.center.y;
    const along = rx * portal.along.x + ry * portal.along.y;
    const across = rx * portal.normal.x + ry * portal.normal.y;
    const outwardOk = portal.kind === 'exit' ? across <= reach && across >= -portal.depthM : Math.abs(across) <= reach;
    if (Math.abs(along) <= portal.widthM / 2 && outwardOk) fn(cy * width + cx);
  }
}

/** Convenience for callers holding only the document: diagnostics that block a run. */
export function blockingDiagnostics(doc: EgressDocument) {
  return deriveLayout(doc).diagnostics.filter(d => d.level === 'error');
}
