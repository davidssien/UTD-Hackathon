import {
  add, applyEdit, cross, DEFAULT_WALL, deriveLayout, diffDocuments, distance, dot, groundFloorId,
  layoutHash, normalize, openingCenter, pointInPolygon, projectOnSegment, scale, segmentIntersection, sub,
  type EgressDocument, type Vec2,
} from '@egress/core';
import { escapeRoutes } from '@egress/sim';
import type { Suggestion } from './candidates.ts';

/** Two existing perpendicular walls enclose the outside corner. Add only its two partitions and a door. */
export function cornerRooms(doc: EgressDocument, jobId: string, width = 3, depth = 3, roomId?: string): Suggestion[] {
  const floorId = groundFloorId(doc);
  const rooms = deriveLayout(doc).topology.rooms.filter(r => r.floorId === floorId && (!roomId || r.id === roomId));
  const vertices = new Map(doc.vertices.filter(v => v.floorId === floorId).map(v => [v.id, v.position]));
  const openings = doc.openings.filter(o => o.floorId === floorId && o.openingKind !== 'window');
  const walls = doc.walls.filter(w => w.floorId === floorId);
  const expectedLayoutHash = layoutHash(doc);
  const results: Suggestion[] = [];
  for (const room of rooms.sort((a, b) => b.area - a.area)) {
    for (let i = 0; i < room.polygon.length; i++) {
      const corner = room.polygon[i], n = room.polygon.length;
      const prev = room.polygon[(i + n - 1) % n], next = room.polygon[(i + 1) % n];
      const u = normalize(sub(prev, corner)), v = normalize(sub(next, corner));
      if (Math.abs(dot(u, v)) > 0.01 || cross(v, u) <= 0) continue;
      // Leave a usable approach around both partition ends.
      if (distance(prev, corner) < width + 1.2 || distance(next, corner) < depth + 1.2) continue;
      const a = add(corner, scale(u, width)), b = add(corner, scale(v, depth));
      const inner = add(a, scale(v, depth)), center = scale(add(inner, corner), 0.5);
      const outline = [corner, a, inner, b];
      if (!pointInPolygon(inner, room.polygon) || !pointInPolygon(center, room.polygon)) continue;
      // Detached interior boxes, existing doors and stairs must stay clear of the new office.
      const within = (p: Vec2, margin: number) => {
        const offset = sub(p, corner), x = dot(offset, u), y = dot(offset, v);
        return x >= -margin && x <= width + margin && y >= -margin && y <= depth + margin;
      };
      if ([...vertices.values()].some(p => within(p, -0.001))) continue;
      if (openings.some(o => { const p = openingCenter(doc, o); return p && within(p, o.widthM / 2 + 0.25); })) continue;
      const xs = outline.map(p => p.x), ys = outline.map(p => p.y);
      if (doc.stairs.some(s => s.floorId === floorId && Math.max(...xs) >= s.min.x && Math.min(...xs) <= s.max.x
        && Math.max(...ys) >= s.min.y && Math.min(...ys) <= s.max.y)) continue;
      if (walls.some(w => {
        const from = vertices.get(w.startVertexId)!, to = vertices.get(w.endVertexId)!;
        return [[a, inner], [inner, b]].some(([p, q]) => {
          const hit = segmentIntersection(from, to, p, q);
          return hit && distance(hit.point, a) > 0.001 && distance(hit.point, b) > 0.001;
        });
      })) continue;

      const id = `${jobId}.office${results.length + 1}`;
      const partitions = applyEdit(doc, { requestId: id, commands: [{ kind: 'createWallChain', floorId, points: [a, inner, b], ...DEFAULT_WALL }] });
      if (!partitions.ok) continue;
      const after = partitions.doc;
      const office = deriveLayout(after).topology.rooms.find(r => r.floorId === floorId && Math.abs(r.area - width * depth) < 0.02 && pointInPolygon(center, r.polygon));
      if (!office) continue;
      const positions = new Map(after.vertices.map(v => [v.id, v.position]));
      const doorAt = scale(add(a, inner), 0.5);
      const partition = after.walls.find(w => office.wallIds.includes(w.id)
        && projectOnSegment(doorAt, positions.get(w.startVertexId)!, positions.get(w.endVertexId)!).distance < 0.001);
      if (!partition) continue;
      const withDoor = applyEdit(after, { requestId: `${id}.door`, commands: [{ kind: 'createOpening', openingKind: 'door', wallId: partition.id,
        offsetM: distance(positions.get(partition.startVertexId)!, doorAt), widthM: 1.0, state: 'open' }] });
      if (!withDoor.ok) continue;
      const route = escapeRoutes(withDoor.doc, center, office.polygon)[0];
      if (!route && openings.some(o => o.openingKind === 'exit' && o.state === 'open')) continue;
      const title = `${width} × ${depth} m corner office at (${+corner.x.toFixed(2)}, ${+corner.y.toFixed(2)})`;
      results.push({ suggestionId: `room${results.length + 1}`, title, targetId: partition.id,
        rationale: `Two partitions and a 1 m door enclose the office. ${route ? `The modeled route from its center to an exit is ${route.distanceM} m.` : 'The current plan has no reachable exit.'}`,
        commands: [{ kind: 'applyPatch', expectedLayoutHash, ...diffDocuments(doc, withDoor.doc) }] });
      if (results.length === 4) return results;
    }
  }
  return results;
}
