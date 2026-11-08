/**
 * Rooms as the agent, the runner and the UI describe them (PLAN.md §3 E, D73): a stable hash
 * of each room's outline (so labels survive edits elsewhere), its size, its doors and exits,
 * and a rule-based kind that Nemotron labels can refine.
 */
import { z } from 'zod';
import { sha256Hex } from '../canonical.ts';
import type { EgressDocument, ID, Vec2 } from '../types.ts';
import { topology } from './topology.ts';

export const RoomKindSchema = z.enum(['room', 'hallway', 'stair', 'closet', 'lobby', 'other']);
export type RoomKind = z.infer<typeof RoomKindSchema>;

/** Kinds that get an escape plan; circulation and storage spaces do not. */
export const PLANNED_ROOM_KINDS: readonly RoomKind[] = ['room', 'lobby', 'other'];

export const RoomLabelSchema = z.object({
  roomHash: z.string().regex(/^[0-9a-f]{16}$/),
  kind: RoomKindSchema,
  name: z.string().trim().min(1).max(60),
  confidence: z.number().min(0).max(1),
  source: z.enum(['nemotron', 'rules', 'user']),
});
export type RoomLabel = z.infer<typeof RoomLabelSchema>;

export interface RoomDescriptor {
  roomHash: string;
  id: string;
  polygon: Vec2[];
  center: Vec2;
  areaM2: number;
  /** Narrow and long sides of the bounding box (m). */
  widthM: number;
  lengthM: number;
  doors: number;
  exits: number;
  windows: number;
  /** Rooms reachable through a door in one step (their hashes). */
  neighbours: string[];
  wallIds: ID[];
  openingIds: ID[];
  exteriorWalls: number;
  /** Kind from the geometry rules alone. */
  ruleKind: RoomKind;
}

const round = (v: number) => Math.round(v * 100) / 100;

/** Outline hash: rounded to 1 cm, starting at the smallest vertex, so the same room hashes the same. */
export function roomHash(polygon: Vec2[]): string {
  const pts = polygon.map(p => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`);
  let start = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i] < pts[start]) start = i;
  return sha256Hex([...pts.slice(start), ...pts.slice(0, start)].join(';')).slice(0, 16);
}

export function roomKindByRules(widthM: number, lengthM: number, areaM2: number, neighbours: number): RoomKind {
  if (areaM2 < 3) return 'closet';
  if ((widthM <= 2.4 && lengthM / Math.max(widthM, 0.1) >= 3) || neighbours >= 3) return 'hallway';
  return 'room';
}

/** What the labeller sees: geometry facts only, no outlines (small enough for one Nemotron call). */
export type RoomFacts = Omit<RoomDescriptor, 'id' | 'polygon' | 'center' | 'wallIds' | 'openingIds'>;

export function roomFacts(room: RoomDescriptor): RoomFacts {
  const { id: _id, polygon: _polygon, center: _center, wallIds: _walls, openingIds: _openings, ...facts } = room;
  return facts;
}

/** Labels from the rules alone: "Hallway", "Room 1" (largest first), "Closet"… The fallback when no model answers. */
export function ruleLabels(rooms: RoomFacts[]): RoomLabel[] {
  const counters = new Map<RoomKind, number>();
  const plural = new Map<RoomKind, number>();
  for (const r of rooms) plural.set(r.ruleKind, (plural.get(r.ruleKind) ?? 0) + 1);
  const title = (k: RoomKind) => k[0].toUpperCase() + k.slice(1);
  return [...rooms].sort((a, b) => b.areaM2 - a.areaM2).map(r => {
    const n = (counters.get(r.ruleKind) ?? 0) + 1;
    counters.set(r.ruleKind, n);
    return { roomHash: r.roomHash, kind: r.ruleKind, name: plural.get(r.ruleKind)! > 1 ? `${title(r.ruleKind)} ${n}` : title(r.ruleKind), confidence: 0.5, source: 'rules' as const };
  });
}

export function describeRooms(doc: EgressDocument): RoomDescriptor[] {
  const topo = topology(doc);
  const roomIds = new Set(topo.rooms.map(r => r.id));
  const hashes = new Map(topo.rooms.map(r => [r.id, roomHash(r.polygon)]));
  return topo.rooms.map(r => {
    const xs = r.polygon.map(p => p.x), ys = r.polygon.map(p => p.y);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    const neighbours = new Set<string>(), openingIds: ID[] = [];
    let doors = 0, exits = 0, windows = 0, exteriorWalls = 0;
    for (const wallId of r.wallIds) {
      const sides = topo.wallSides.get(wallId);
      const faces = sides ? [sides.left, sides.right] : [];
      if (faces.some(f => !roomIds.has(f))) exteriorWalls++;
      for (const o of doc.openings) {
        if (o.wallId !== wallId) continue;
        openingIds.push(o.id);
        if (o.openingKind === 'exit') exits++;
        else if (o.openingKind === 'window') windows++;
        else {
          doors++;
          for (const f of faces) if (f !== r.id && roomIds.has(f)) neighbours.add(hashes.get(f)!);
        }
      }
    }
    const widthM = round(Math.min(w, h)), lengthM = round(Math.max(w, h)), areaM2 = round(r.area);
    return {
      roomHash: hashes.get(r.id)!, id: r.id, polygon: r.polygon,
      center: { x: round(xs.reduce((a, b) => a + b, 0) / xs.length), y: round(ys.reduce((a, b) => a + b, 0) / ys.length) },
      areaM2, widthM, lengthM, doors, exits, windows, neighbours: [...neighbours], wallIds: [...r.wallIds], openingIds: [...new Set(openingIds)],
      exteriorWalls, ruleKind: roomKindByRules(widthM, lengthM, areaM2, neighbours.size),
    };
  });
}
