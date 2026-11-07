/** Small, allocation-light 2D helpers. World meters, +y north. */
import type { Vec2 } from './types.ts';

export const EPS = 1e-9;
/** Endpoints closer than this are the same vertex. */
export const VERTEX_MERGE_M = 0.001;
export const MIN_WALL_LENGTH_M = 0.5;
/** Openings keep at least this much solid wall at each end. */
export const OPENING_END_CLEARANCE_M = 0.1;

export const vec = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
export const length = (a: Vec2) => Math.hypot(a.x, a.y);
export const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const normalize = (a: Vec2): Vec2 => {
  const l = length(a);
  return l < EPS ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
};
/** Left-hand normal (CCW rotation by 90°). */
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });

/** Parameter t ∈ [0,1] of the closest point on segment ab to p, and the distance to it. */
export function projectOnSegment(p: Vec2, a: Vec2, b: Vec2): { t: number; point: Vec2; distance: number } {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  const t = len2 < EPS ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / len2));
  const point = lerp(a, b, t);
  return { t, point, distance: distance(p, point) };
}

/**
 * Intersection of segments ab and cd. Returns parameters along each segment
 * (inclusive of endpoints) or null when they do not touch. Collinear overlaps
 * return null; callers that care handle them separately.
 */
export function segmentIntersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): { t: number; u: number; point: Vec2 } | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const denom = cross(r, s);
  if (Math.abs(denom) < EPS) return null;
  const ca = sub(c, a);
  const t = cross(ca, s) / denom;
  const u = cross(ca, r) / denom;
  const tol = 1e-9;
  if (t < -tol || t > 1 + tol || u < -tol || u > 1 + tol) return null;
  return { t: Math.max(0, Math.min(1, t)), u: Math.max(0, Math.min(1, u)), point: lerp(a, b, t) };
}

/** Signed area (positive = counter-clockwise). */
export function signedArea(points: Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i], q = points[(i + 1) % points.length];
    sum += p.x * q.y - q.x * p.y;
  }
  return sum / 2;
}

export function pointInPolygon(p: Vec2, polygon: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
