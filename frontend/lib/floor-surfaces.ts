import { Float32BufferAttribute, Shape, ShapeGeometry, ShapeUtils, Vector2, BufferGeometry } from 'three';
import { signedArea, type Slab, type Vec2 } from '@egress/core';

type Cutout = { min: Vec2; max: Vec2 };

/** Split a convex face at one cutout edge. Both halves retain the input winding. */
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

/** Cut rectangular openings out of the triangulated surface, even when it spans adjoining slabs. */
export function floorSurface(polygon: Vec2[], cutouts: Cutout[]): BufferGeometry {
  const points = polygon.map(p => new Vector2(p.x, p.y));
  const overlaps = cutouts.filter(s => polygon.some(p => p.x > s.min.x) && polygon.some(p => p.x < s.max.x)
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

/** Smaller rectangular finishes take precedence where saved slabs cover the same floor.
 * Clipping the base mesh also keeps ray picking and shadows consistent with the visible finish. */
export function slabCutouts(slabs: Slab[]): Map<string, Cutout[]> {
  const result = new Map<string, Cutout[]>();
  const rectangles = new Map<string, Cutout[]>();
  const ordered = slabs.map(slab => ({ slab, area: Math.abs(signedArea(slab.polygon)) }))
    .sort((a, b) => a.area - b.area || a.slab.id.localeCompare(b.slab.id));
  for (const { slab, area } of ordered) {
    const xs = slab.polygon.map(p => p.x), ys = slab.polygon.map(p => p.y);
    const min = { x: Math.min(...xs), y: Math.min(...ys) }, max = { x: Math.max(...xs), y: Math.max(...ys) };
    const floor = rectangles.get(slab.floorId) ?? [];
    const overlap = floor.filter(r => r.min.x < max.x && r.max.x > min.x && r.min.y < max.y && r.max.y > min.y);
    if (overlap.length) result.set(slab.id, overlap);
    const isRectangle = slab.polygon.length === 4 && area > 0 && slab.polygon.every((p, i) => {
      const next = slab.polygon[(i + 1) % 4];
      return (p.x === next.x) !== (p.y === next.y);
    });
    if (isRectangle) {
      floor.push({ min, max });
      rectangles.set(slab.floorId, floor);
    }
  }
  return result;
}
