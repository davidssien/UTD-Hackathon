/**
 * Geometry diagnostics (docs/ARCHITECTURE.md §4). The editor saves invalid drafts; the
 * simulation reports these instead of crashing.
 */
import type { EgressDocument, ID } from '../types.ts';
import type { Topology } from './topology.ts';
import { isPassable } from './walls.ts';

export type DiagnosticCode = 'NOT_ENCLOSED' | 'NO_EXIT' | 'EXIT_ON_INTERIOR_WALL' | 'EXIT_CLOSED' | 'UNREACHABLE_ROOM';

export interface GeometryDiagnostic {
  level: 'info' | 'warning' | 'error';
  code: DiagnosticCode;
  entityIds: ID[];
  message: string;
}

export function diagnostics(doc: EgressDocument, topo: Topology): GeometryDiagnostic[] {
  const out: GeometryDiagnostic[] = [];
  if (doc.walls.length === 0) return out;
  const isRoom = (faceId: string) => (topo.faceById.get(faceId)?.area ?? 0) > 1e-6;

  if (topo.rooms.length === 0) {
    out.push({ level: 'error', code: 'NOT_ENCLOSED', entityIds: [], message: 'No closed room yet. Close the gaps between walls so people have an inside to start in.' });
  }

  const exits = doc.openings.filter(o => o.openingKind === 'exit');
  if (exits.length === 0) out.push({ level: 'error', code: 'NO_EXIT', entityIds: [], message: 'Add at least one exit on an outside wall.' });

  // Rooms connected through passable openings; exits on exterior walls are the goal.
  const graph = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    graph.set(a, (graph.get(a) ?? new Set()).add(b));
    graph.set(b, (graph.get(b) ?? new Set()).add(a));
  };
  const reachable = new Set<string>();
  for (const o of doc.openings) {
    const sides = topo.wallSides.get(o.wallId);
    if (!sides) continue;
    const leftRoom = isRoom(sides.left), rightRoom = isRoom(sides.right);
    if (o.openingKind === 'exit') {
      if (leftRoom && rightRoom) {
        out.push({ level: 'warning', code: 'EXIT_ON_INTERIOR_WALL', entityIds: [o.id], message: 'This exit is on an interior wall, so it does not lead outside. Use a door instead, or move it to an outside wall.' });
      }
      if (o.state === 'closed') out.push({ level: 'warning', code: 'EXIT_CLOSED', entityIds: [o.id], message: 'This exit is closed; nobody can leave through it.' });
      if (isPassable(o) && leftRoom !== rightRoom) reachable.add(leftRoom ? sides.left : sides.right);
    }
    if (isPassable(o) && leftRoom && rightRoom) link(sides.left, sides.right);
  }
  const queue = [...reachable];
  while (queue.length) {
    const room = queue.pop()!;
    for (const next of graph.get(room) ?? []) if (!reachable.has(next)) { reachable.add(next); queue.push(next); }
  }
  if (exits.length) {
    for (const room of topo.rooms) {
      if (!reachable.has(room.id)) {
        out.push({ level: 'warning', code: 'UNREACHABLE_ROOM', entityIds: room.wallIds, message: `A ${room.area.toFixed(1)} m² room has no open path to an exit. Anyone starting there is reported as unreachable.` });
      }
    }
  }
  return out;
}
