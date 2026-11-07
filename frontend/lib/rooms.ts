import type { Wall } from './floorplan';
import type { Point } from './building-editor';

export function polygonArea(points: Point[]): number {
  return Math.abs(points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]; return sum + p.x * q.z - q.x * p.z; }, 0)) / 2;
}

export function containsPoint(points: Point[], point: Point): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a.z > point.z) !== (b.z > point.z) && point.x < (b.x - a.x) * (point.z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

const roomCache = new WeakMap<Wall[], Point[][]>();

// Split intersecting wall centerlines into a planar graph, then traverse its
// directed edges to recover bounded faces. Openings attached to a wall retain
// its centerline, so doors do not leak a room into its neighbor.
export function enclosedRooms(walls: Wall[]): Point[][] {
  const cached = roomCache.get(walls); if (cached) return cached;
  const cuts = walls.map(() => [0, 1]);
  const cross = (ax: number, az: number, bx: number, bz: number) => ax * bz - az * bx;
  for (let i = 0; i < walls.length; i++) for (let j = i + 1; j < walls.length; j++) {
    const a = walls[i], b = walls[j];
    const ax = a.x2 - a.x1, az = a.z2 - a.z1, bx = b.x2 - b.x1, bz = b.z2 - b.z1;
    const dx = b.x1 - a.x1, dz = b.z1 - a.z1, denominator = cross(ax, az, bx, bz);
    if (Math.abs(denominator) > .000001) {
      const t = cross(dx, dz, bx, bz) / denominator, u = cross(dx, dz, ax, az) / denominator;
      if (t >= -1e-6 && t <= 1 + 1e-6 && u >= -1e-6 && u <= 1 + 1e-6) { cuts[i].push(Math.max(0, Math.min(1, t))); cuts[j].push(Math.max(0, Math.min(1, u))); }
    } else if (Math.abs(cross(dx, dz, ax, az)) < .000001) {
      for (const [index, w, other] of [[i, a, b], [j, b, a]] as const) {
        const vx = w.x2 - w.x1, vz = w.z2 - w.z1, length2 = vx * vx + vz * vz;
        if (!length2) continue;
        for (const p of [{ x: other.x1, z: other.z1 }, { x: other.x2, z: other.z2 }]) {
          const t = ((p.x - w.x1) * vx + (p.z - w.z1) * vz) / length2;
          if (t > 0 && t < 1) cuts[index].push(t);
        }
      }
    }
  }
  const vertices: Point[] = [], indices = new Map<string, number>(), adjacency = new Map<number, Set<number>>();
  const vertex = (x: number, z: number) => {
    const key = `${Math.round(x * 10000)},${Math.round(z * 10000)}`;
    let id = indices.get(key);
    if (id === undefined) { id = vertices.length; vertices.push({ x, z }); indices.set(key, id); adjacency.set(id, new Set()); }
    return id;
  };
  walls.forEach((w, i) => {
    const splits = [...new Set(cuts[i])].sort((a, b) => a - b);
    for (let j = 1; j < splits.length; j++) {
      const a = vertex(w.x1 + (w.x2 - w.x1) * splits[j - 1], w.z1 + (w.z2 - w.z1) * splits[j - 1]);
      const b = vertex(w.x1 + (w.x2 - w.x1) * splits[j], w.z1 + (w.z2 - w.z1) * splits[j]);
      if (a !== b) { adjacency.get(a)!.add(b); adjacency.get(b)!.add(a); }
    }
  });
  const neighbors = vertices.map((p, i) => [...adjacency.get(i)!].sort((a, b) => Math.atan2(vertices[a].z - p.z, vertices[a].x - p.x) - Math.atan2(vertices[b].z - p.z, vertices[b].x - p.x)));
  const visited = new Set<string>(), rooms: Point[][] = [];
  const edgeCount = neighbors.reduce((sum, list) => sum + list.length, 0);
  for (let start = 0; start < vertices.length; start++) for (const next of neighbors[start]) {
    if (visited.has(`${start}:${next}`)) continue;
    const loop: number[] = []; let a = start, b = next, closed = false;
    for (let step = 0; step <= edgeCount; step++) {
      if (visited.has(`${a}:${b}`)) { closed = a === start && b === next; break; }
      visited.add(`${a}:${b}`); loop.push(a);
      const list = neighbors[b], index = list.indexOf(a);
      const c = list[(index - 1 + list.length) % list.length]; a = b; b = c;
    }
    if (!closed) continue;
    // Remove dead-end spurs and collinear intermediate vertices.
    let changed = true;
    while (changed && loop.length > 2) {
      changed = false;
      for (let i = 0; i < loop.length; i++) {
        const p = vertices[loop[(i - 1 + loop.length) % loop.length]], q = vertices[loop[i]], r = vertices[loop[(i + 1) % loop.length]];
        if (Math.abs(cross(q.x - p.x, q.z - p.z, r.x - q.x, r.z - q.z)) < 1e-7) { loop.splice(i, 1); changed = true; break; }
      }
    }
    const points = loop.map(id => vertices[id]);
    const signedArea = points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]; return sum + p.x * q.z - q.x * p.z; }, 0) / 2;
    if (points.length >= 3 && signedArea > .1) rooms.push(points);
  }
  rooms.sort((a, b) => polygonArea(a) - polygonArea(b));
  roomCache.set(walls, rooms); return rooms;
}

export function roomAt(walls: Wall[], point: Point): Point[] | undefined {
  return enclosedRooms(walls).find(room => containsPoint(room, point));
}
