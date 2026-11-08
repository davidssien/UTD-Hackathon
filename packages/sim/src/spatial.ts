/**
 * Spatial indexes: static wall geometry buckets and a per-tick actor hash.
 * Bucket size is coarser than the 0.25 m grid on purpose (Plan.md §5.1).
 */
import { pointInPolygon, type GridDefinition, type Vec2 } from '@egress/core';

export const BUCKET_M = 1.25;

export interface Segment {
  a: Vec2;
  b: Vec2;
}

interface Buckets {
  x0: number;
  y0: number;
  cols: number;
  rows: number;
}

function bucketsFor(grid: GridDefinition): Buckets {
  return {
    x0: grid.origin.x,
    y0: grid.origin.y,
    cols: Math.max(1, Math.ceil((grid.width * grid.cellSizeM) / BUCKET_M)),
    rows: Math.max(1, Math.ceil((grid.height * grid.cellSizeM) / BUCKET_M)),
  };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Wall edges and solid polygons, bucketed by bounding box (+ a margin for radius queries). */
export class SegmentIndex {
  readonly segments: Segment[];
  readonly polygons: Vec2[][];
  private readonly b: Buckets;
  private readonly segBuckets: number[][];
  private readonly polyBuckets: number[][];

  constructor(grid: GridDefinition, segments: Segment[], polygons: Vec2[][], margin = 0.6) {
    this.segments = segments;
    this.polygons = polygons;
    this.b = bucketsFor(grid);
    const count = this.b.cols * this.b.rows;
    this.segBuckets = Array.from({ length: count }, () => []);
    this.polyBuckets = Array.from({ length: count }, () => []);
    segments.forEach((s, i) => this.insert(this.segBuckets, i, Math.min(s.a.x, s.b.x) - margin, Math.min(s.a.y, s.b.y) - margin, Math.max(s.a.x, s.b.x) + margin, Math.max(s.a.y, s.b.y) + margin));
    polygons.forEach((poly, i) => {
      const xs = poly.map(p => p.x), ys = poly.map(p => p.y);
      this.insert(this.polyBuckets, i, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
    });
  }

  private insert(target: number[][], index: number, x0: number, y0: number, x1: number, y1: number) {
    const { cols, rows } = this.b;
    const c0 = clamp(Math.floor((x0 - this.b.x0) / BUCKET_M), 0, cols - 1), c1 = clamp(Math.floor((x1 - this.b.x0) / BUCKET_M), 0, cols - 1);
    const r0 = clamp(Math.floor((y0 - this.b.y0) / BUCKET_M), 0, rows - 1), r1 = clamp(Math.floor((y1 - this.b.y0) / BUCKET_M), 0, rows - 1);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) target[r * cols + c].push(index);
  }

  private bucket(x: number, y: number): number {
    const c = clamp(Math.floor((x - this.b.x0) / BUCKET_M), 0, this.b.cols - 1);
    const r = clamp(Math.floor((y - this.b.y0) / BUCKET_M), 0, this.b.rows - 1);
    return r * this.b.cols + c;
  }

  /** Segments that may lie within `margin` (0.6 m) of the point. */
  near(x: number, y: number): number[] {
    return this.segBuckets[this.bucket(x, y)];
  }

  /** True if the point lies inside any solid wall polygon. */
  insideSolid(x: number, y: number): boolean {
    const p = { x, y };
    for (const i of this.polyBuckets[this.bucket(x, y)]) if (pointInPolygon(p, this.polygons[i])) return true;
    return false;
  }

  /** True if segment p→q crosses any wall edge (used to stop tunnelling). */
  crosses(px: number, py: number, qx: number, qy: number): boolean {
    const seen = new Set<number>();
    for (const list of [this.near(px, py), this.near(qx, qy)]) {
      for (const i of list) {
        if (seen.has(i)) continue;
        seen.add(i);
        const s = this.segments[i];
        if (segmentsIntersect(px, py, qx, qy, s.a.x, s.a.y, s.b.x, s.b.y)) return true;
      }
    }
    return false;
  }
}

export function segmentsIntersect(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return false;
  const qx = cx - ax, qy = cy - ay;
  const t = (qx * sy - qy * sx) / denom, u = (qx * ry - qy * rx) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/** Closest point on segment ab to p, as [x, y, distance]. */
export function closestOnSegment(px: number, py: number, s: Segment): [number, number, number] {
  const abx = s.b.x - s.a.x, aby = s.b.y - s.a.y;
  const len2 = abx * abx + aby * aby;
  let t = len2 > 0 ? ((px - s.a.x) * abx + (py - s.a.y) * aby) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = s.a.x + abx * t, y = s.a.y + aby * t;
  return [x, y, Math.hypot(px - x, py - y)];
}

/** Rebuilt every tick: bucket heads + linked list through actor indices. */
export class ActorHash {
  private readonly b: Buckets;
  readonly head: Int32Array;
  readonly next: Int32Array;

  constructor(grid: GridDefinition, capacity: number) {
    this.b = bucketsFor(grid);
    this.head = new Int32Array(this.b.cols * this.b.rows);
    this.next = new Int32Array(capacity);
  }

  rebuild(x: Float64Array, y: Float64Array, active: (i: number) => boolean, count: number) {
    this.head.fill(-1);
    for (let i = count - 1; i >= 0; i--) {
      if (!active(i)) continue;
      const k = this.bucketOf(x[i], y[i]);
      this.next[i] = this.head[k];
      this.head[k] = i;
    }
  }

  bucketOf(x: number, y: number): number {
    const c = clamp(Math.floor((x - this.b.x0) / BUCKET_M), 0, this.b.cols - 1);
    const r = clamp(Math.floor((y - this.b.y0) / BUCKET_M), 0, this.b.rows - 1);
    return r * this.b.cols + c;
  }

  /** Calls fn for every actor in the 3×3 buckets around (x, y). */
  forNear(x: number, y: number, fn: (j: number) => void) {
    const c = clamp(Math.floor((x - this.b.x0) / BUCKET_M), 0, this.b.cols - 1);
    const r = clamp(Math.floor((y - this.b.y0) / BUCKET_M), 0, this.b.rows - 1);
    for (let rr = Math.max(0, r - 1); rr <= Math.min(this.b.rows - 1, r + 1); rr++) {
      for (let cc = Math.max(0, c - 1); cc <= Math.min(this.b.cols - 1, c + 1); cc++) {
        for (let j = this.head[rr * this.b.cols + cc]; j !== -1; j = this.next[j]) fn(j);
      }
    }
  }
}
