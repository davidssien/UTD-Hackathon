/** Stair geometry for the scene (PLAN.md D75). Pure, so it can be unit tested. */
import { Float32BufferAttribute, Shape, ShapeGeometry, ShapeUtils, Vector2, BufferGeometry } from 'three';
import type { Stair, Vec2 } from '@egress/core';

/** Riser height the step count aims for (m). */
export const RISER_M = 0.18;

/** Steps of a straight stair as plan rectangles with their top heights above the lower floor, bottom step first. */
export function stairSteps(stair: Pick<Stair, 'min' | 'max' | 'upEdge'>, rise: number): { min: Vec2; max: Vec2; top: number }[] {
  const vertical = stair.upEdge === 'n' || stair.upEdge === 's';
  const run = vertical ? stair.max.y - stair.min.y : stair.max.x - stair.min.x;
  const n = Math.max(3, Math.round(rise / RISER_M));
  // Keep a level landing within the footprint, including on short legacy stairs.
  const landing = Math.min(1, Math.max(0.6, run / n), run * 0.75);
  const tread = (run - landing) / (n - 1);
  const steps: { min: Vec2; max: Vec2; top: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = tread * i, b = i === n - 1 ? run : tread * (i + 1), top = rise * (i + 1) / n;
    if (stair.upEdge === 'n') steps.push({ min: { x: stair.min.x, y: stair.min.y + a }, max: { x: stair.max.x, y: stair.min.y + b }, top });
    else if (stair.upEdge === 's') steps.push({ min: { x: stair.min.x, y: stair.max.y - b }, max: { x: stair.max.x, y: stair.max.y - a }, top });
    else if (stair.upEdge === 'e') steps.push({ min: { x: stair.min.x + a, y: stair.min.y }, max: { x: stair.min.x + b, y: stair.max.y }, top });
    else steps.push({ min: { x: stair.max.x - b, y: stair.min.y }, max: { x: stair.max.x - a, y: stair.max.y }, top });
  }
  return steps;
}

type Shaft = Pick<Stair, 'min' | 'max'>;

/** Split a convex face at one shaft edge. Both halves retain the input winding. */
function splitFace(face: Vec2[], axis: 'x' | 'y', edge: number, sign: number): [Vec2[], Vec2[]] {
  const inside: Vec2[] = [], outside: Vec2[] = [];
  let a = face[face.length - 1];
  for (const b of face) {
    const da = sign * (a[axis] - edge), db = sign * (b[axis] - edge);
    if (da * db < 0) {
      const t = da / (da - db);
      const point = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
      inside.push(point); outside.push(point);
    }
    if (db >= 0) inside.push(b);
    if (db <= 0) outside.push(b);
    a = b;
  }
  return [inside, outside];
}

/** Cut each shaft out of the triangulated surface, even when it spans adjoining slabs. */
export function floorSurface(polygon: Vec2[], shafts: Shaft[]): BufferGeometry {
  const points = polygon.map(p => new Vector2(p.x, p.y));
  const overlaps = shafts.filter(s => polygon.some(p => p.x > s.min.x) && polygon.some(p => p.x < s.max.x)
    && polygon.some(p => p.y > s.min.y) && polygon.some(p => p.y < s.max.y));
  if (!overlaps.length) return new ShapeGeometry(new Shape(points));
  let faces: Vec2[][] = ShapeUtils.triangulateShape(points, []).map(ids => ids.map(i => points[i]));
  for (const { min, max } of overlaps) {
    const edges = [['x', min.x, 1], ['x', max.x, -1], ['y', min.y, 1], ['y', max.y, -1]] as const;
    const next: Vec2[][] = [];
    for (let face of faces) {
      for (const [axis, edge, sign] of edges) {
        const [inside, outside] = splitFace(face, axis, edge, sign);
        if (outside.length >= 3) next.push(outside);
        if (inside.length < 3) break;
        face = inside;
      }
    }
    faces = next;
  }
  const positions: number[] = [], uv: number[] = [];
  for (const face of faces) for (let i = 1; i < face.length - 1; i++) {
    for (const p of [face[0], face[i], face[i + 1]]) { positions.push(p.x, p.y, 0); uv.push(p.x, p.y); }
  }
  const mesh = new BufferGeometry();
  mesh.setAttribute('position', new Float32BufferAttribute(positions, 3));
  mesh.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  mesh.computeVertexNormals();
  return mesh;
}

/** The side of a dragged rectangle that rises: the drag direction along its longer axis. */
export function upEdgeOf(from: Vec2, to: Vec2): Stair['upEdge'] {
  const dx = to.x - from.x, dy = to.y - from.y;
  return Math.abs(dy) >= Math.abs(dx) ? (dy >= 0 ? 'n' : 's') : (dx >= 0 ? 'e' : 'w');
}
