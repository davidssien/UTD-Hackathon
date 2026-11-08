/**
 * Wall polygons with computed corners (docs/ARCHITECTURE.md §4, D5). No corner assets: at
 * every vertex the incident walls are sorted by angle and neighbouring edge
 * lines are intersected. Degree 1 → flat cap; degree 2 → miter (bevel when the
 * miter would spike); degree ≥ 3 → miters plus a hub polygon in the middle.
 * The same polygons feed the 2D plan, 3D extrusion and simulation collision.
 */
import { add, cross, distance, normalize, perp, scale, sub } from '../geometry.ts';
import type { EgressDocument, ID, Opening, Vec2, Wall } from '../types.ts';

export interface WallPiece {
  wallId: ID;
  floorId: ID;
  /** Counter-clockwise outline of one solid stretch of the wall. */
  polygon: Vec2[];
  /** Stretch along the wall centerline, meters from the start vertex. */
  fromM: number;
  toM: number;
}

export interface JunctionHub {
  vertexId: ID;
  floorId: ID;
  /** Counter-clockwise polygon filling the middle of a junction. */
  polygon: Vec2[];
}

export interface WallGeometry {
  pieces: WallPiece[];
  hubs: JunctionHub[];
}

export interface WallGeometryOptions {
  /** Which openings cut holes. Default: all (rendering). The simulation cuts only passable ones. */
  cut?: (opening: Opening) => boolean;
}

/** Miters longer than this many half-thicknesses become bevels. */
const MITER_LIMIT = 4;

interface End {
  wall: Wall;
  dir: Vec2; // outgoing from the vertex
  half: number;
  angle: number;
  left?: Vec2; // relative to `dir`
  right?: Vec2;
}

export function wallGeometry(doc: EgressDocument, options: WallGeometryOptions = {}): WallGeometry {
  const cut = options.cut ?? (() => true);
  const pos = new Map(doc.vertices.map(v => [v.id, v.position]));
  const ends = new Map<ID, End[]>();
  const endOf = new Map<string, End>(); // `${wallId}:${vertexId}`
  for (const w of doc.walls) {
    const a = pos.get(w.startVertexId), b = pos.get(w.endVertexId);
    if (!a || !b || distance(a, b) < 1e-9) continue;
    const d = normalize(sub(b, a));
    for (const [vertexId, dir] of [[w.startVertexId, d], [w.endVertexId, scale(d, -1)]] as const) {
      const end: End = { wall: w, dir, half: w.thicknessM / 2, angle: Math.atan2(dir.y, dir.x) };
      const list = ends.get(vertexId) ?? [];
      list.push(end);
      ends.set(vertexId, list);
      endOf.set(`${w.id}:${vertexId}`, end);
    }
  }

  const hubs: JunctionHub[] = [];
  for (const [vertexId, list] of ends) {
    const v = pos.get(vertexId)!;
    list.sort((p, q) => p.angle - q.angle || (p.wall.id < q.wall.id ? -1 : 1));
    if (list.length === 1) {
      const e = list[0];
      e.left = add(v, scale(perp(e.dir), e.half));
      e.right = sub(v, scale(perp(e.dir), e.half));
      continue;
    }
    const hub: Vec2[] = [];
    let beveled = false;
    for (let i = 0; i < list.length; i++) {
      const a = list[i], b = list[(i + 1) % list.length];
      let gap = b.angle - a.angle;
      if (gap <= 0) gap += 2 * Math.PI;
      const pa = add(v, scale(perp(a.dir), a.half)); // a's left edge passes through pa
      const pb = sub(v, scale(perp(b.dir), b.half)); // b's right edge passes through pb
      const join = lineIntersection(pa, a.dir, pb, b.dir) ?? scale(add(pa, pb), 0.5);
      if (distance(join, v) <= MITER_LIMIT * Math.max(a.half, b.half)) {
        a.left = join;
        b.right = join;
        hub.push(join);
      } else if (gap < Math.PI) {
        // Sharp inner corner: the walls overlap there anyway; end them at the vertex.
        a.left = pa;
        b.right = pb;
        hub.push(v);
      } else {
        // Sharp outer corner: bevel instead of a long spike; the hub fills the notch.
        a.left = pa;
        b.right = pb;
        hub.push(pa, pb);
        beveled = true;
      }
    }
    if ((list.length >= 3 || beveled) && hub.length >= 3) hubs.push({ vertexId, floorId: list[0].wall.floorId, polygon: hub });
  }

  const pieces: WallPiece[] = [];
  for (const w of doc.walls) {
    const a = pos.get(w.startVertexId), b = pos.get(w.endVertexId);
    const s = endOf.get(`${w.id}:${w.startVertexId}`), e = endOf.get(`${w.id}:${w.endVertexId}`);
    if (!a || !b || !s || !e) continue;
    const len = distance(a, b);
    const d = normalize(sub(b, a));
    const n = scale(perp(d), w.thicknessM / 2);
    const at = (t: number) => add(a, scale(d, t));
    const holes = doc.openings
      .filter(o => o.wallId === w.id && cut(o))
      .map(o => [Math.max(0, o.offsetM - o.widthM / 2), Math.min(len, o.offsetM + o.widthM / 2)] as const)
      .sort((p, q) => p[0] - q[0]);
    let cursor = 0;
    for (const [lo, hi] of [...holes, [len, len] as const]) {
      if (lo - cursor > 1e-6) {
        const startRight = cursor === 0 ? s.right! : sub(at(cursor), n);
        const startLeft = cursor === 0 ? s.left! : add(at(cursor), n);
        // At the end vertex the outgoing direction is reversed, so its left is the wall's right.
        const endRight = lo >= len - 1e-9 ? e.left! : sub(at(lo), n);
        const endLeft = lo >= len - 1e-9 ? e.right! : add(at(lo), n);
        pieces.push({ wallId: w.id, floorId: w.floorId, polygon: [startRight, endRight, endLeft, startLeft], fromM: cursor, toM: lo });
      }
      cursor = Math.max(cursor, hi);
    }
  }
  return { pieces, hubs };
}

function lineIntersection(p: Vec2, d: Vec2, q: Vec2, e: Vec2): Vec2 | null {
  const denom = cross(d, e);
  if (Math.abs(denom) < 1e-9) return null;
  const t = cross(sub(q, p), e) / denom;
  return add(p, scale(d, t));
}

/** Openings a pedestrian can pass through: open doors and open exits. */
export const isPassable = (o: Opening) => o.openingKind !== 'window' && o.state === 'open';

/** Center point of an opening on its wall, or null if the wall is missing. */
export function openingCenter(doc: EgressDocument, opening: Opening): Vec2 | null {
  const wall = doc.walls.find(w => w.id === opening.wallId);
  const a = wall && doc.vertices.find(v => v.id === wall.startVertexId)?.position;
  const b = wall && doc.vertices.find(v => v.id === wall.endVertexId)?.position;
  if (!a || !b) return null;
  const d = normalize(sub(b, a));
  return add(a, scale(d, opening.offsetM));
}

/** The opening's span as a segment on the wall centerline. */
export function openingSegment(doc: EgressDocument, opening: Opening): { a: Vec2; b: Vec2; normal: Vec2 } | null {
  const wall = doc.walls.find(w => w.id === opening.wallId);
  const a = wall && doc.vertices.find(v => v.id === wall.startVertexId)?.position;
  const b = wall && doc.vertices.find(v => v.id === wall.endVertexId)?.position;
  if (!a || !b) return null;
  const d = normalize(sub(b, a));
  return {
    a: add(a, scale(d, opening.offsetM - opening.widthM / 2)),
    b: add(a, scale(d, opening.offsetM + opening.widthM / 2)),
    normal: perp(d),
  };
}
