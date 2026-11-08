/**
 * Rooms and building boundary derived from the planar wall graph (docs/ARCHITECTURE.md §4).
 * Faces are traced by always turning to the next edge clockwise from where we
 * came from, which walks every bounded face counter-clockwise (positive area,
 * a room) and each component's outer face clockwise (the exterior). Same idea
 * as ExitCraft's rooms.ts, but on explicit vertices so no epsilon matching.
 */
import { signedArea } from '../geometry.ts';
import type { EgressDocument, ID, Vec2 } from '../types.ts';

export interface Face {
  /** Deterministic id: floor + smallest directed edge key on the boundary. */
  id: string;
  floorId: ID;
  vertexIds: ID[];
  polygon: Vec2[];
  /** Positive for rooms, ≤ 0 for exterior faces. */
  area: number;
  wallIds: ID[];
}

export interface WallSides {
  /** Face on the left of start→end, and on the right. */
  left: string;
  right: string;
}

export interface Topology {
  rooms: Face[];
  exterior: Face[];
  /** Wall id → faces on each side. A wall with the same face on both sides is a free-standing spur. */
  wallSides: Map<ID, WallSides>;
  faceById: Map<string, Face>;
}

export function topology(doc: EgressDocument): Topology {
  const pos = new Map(doc.vertices.map(v => [v.id, v.position]));
  const rooms: Face[] = [], exterior: Face[] = [];
  const wallSides = new Map<ID, WallSides>();
  const faceById = new Map<string, Face>();

  for (const floor of doc.floors) {
    const walls = doc.walls.filter(w => w.floorId === floor.id && pos.has(w.startVertexId) && pos.has(w.endVertexId));
    const neighbors = new Map<ID, ID[]>();
    const wallOf = new Map<string, ID>();
    for (const w of walls) {
      for (const [u, v] of [[w.startVertexId, w.endVertexId], [w.endVertexId, w.startVertexId]]) {
        neighbors.set(u, [...(neighbors.get(u) ?? []), v]);
        wallOf.set(`${u}>${v}`, w.id);
      }
    }
    for (const [u, list] of neighbors) {
      const p = pos.get(u)!;
      list.sort((a, b) => {
        const pa = pos.get(a)!, pb = pos.get(b)!;
        return Math.atan2(pa.y - p.y, pa.x - p.x) - Math.atan2(pb.y - p.y, pb.x - p.x);
      });
    }

    const visited = new Set<string>();
    const keys = [...wallOf.keys()].sort();
    for (const startKey of keys) {
      if (visited.has(startKey)) continue;
      const [s0, t0] = startKey.split('>');
      const loop: ID[] = [];
      const edges: string[] = [];
      let u = s0, v = t0;
      for (let guard = 0; guard <= keys.length; guard++) {
        const key = `${u}>${v}`;
        if (visited.has(key)) break;
        visited.add(key);
        edges.push(key);
        loop.push(u);
        const list = neighbors.get(v)!;
        const next = list[(list.indexOf(u) - 1 + list.length) % list.length];
        u = v;
        v = next;
      }
      const polygon = loop.map(id => pos.get(id)!);
      const face: Face = {
        id: `${floor.id}#${[...edges].sort()[0]}`,
        floorId: floor.id,
        vertexIds: loop,
        polygon,
        area: signedArea(polygon),
        wallIds: [...new Set(edges.map(k => wallOf.get(k)!))],
      };
      faceById.set(face.id, face);
      (face.area > 1e-6 ? rooms : exterior).push(face);
      for (const key of edges) {
        const wallId = wallOf.get(key)!;
        const wall = walls.find(w => w.id === wallId)!;
        const sides = wallSides.get(wallId) ?? { left: '', right: '' };
        if (key === `${wall.startVertexId}>${wall.endVertexId}`) sides.left = face.id;
        else sides.right = face.id;
        wallSides.set(wallId, sides);
      }
    }
  }
  return { rooms, exterior, wallSides, faceById };
}
