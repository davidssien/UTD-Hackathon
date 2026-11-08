/**
 * Grounded layout for the agent (PLAN.md §3 D, D72): rooms with a kind, walls with the rooms on
 * each side and their openings, a resolver that turns "a door at the far end of the hallway
 * from that exit" into a valid edit, and modeled code-style checks. Pure functions of the
 * document so the browser mock and the runner give identical answers.
 */
import {
  applyEdit, deriveLayout, describeRooms, DomainError, openingCenter, pointInPolygon, type RoomKind,
  type EditCommand, type EgressDocument, type ID, type OpeningKind, type Vec2,
} from '@egress/core';
import { compileFloor } from '@egress/sim';

export type { RoomKind } from '@egress/core';

export interface RoomInfo {
  id: string;
  floorId: string;
  roomHash: string;
  kind: RoomKind;
  areaM2: number;
  /** Narrow and long sides of the room's bounding box (m). */
  widthM: number;
  lengthM: number;
  center: Vec2;
  wallIds: ID[];
  /** Rooms reachable through a door in one step (room hashes). */
  neighbours: string[];
  openingIds: ID[];
}

export interface WallInfo {
  id: ID;
  lengthM: number;
  from: Vec2;
  to: Vec2;
  exterior: boolean;
  roomIds: string[];
  openings: { id: ID; kind: OpeningKind; widthM: number; offsetM: number }[];
}

const round = (v: number) => Math.round(v * 100) / 100;

/** `labels` (room hash → kind) lets Nemotron or user labels override the rule kinds. */
export function describeLayout(doc: EgressDocument, labels?: ReadonlyMap<string, RoomKind>): { rooms: RoomInfo[]; walls: WallInfo[] } {
  const { topology } = deriveLayout(doc);
  const pos = new Map(doc.vertices.map(v => [v.id, v.position]));
  const roomIds = new Set(topology.rooms.map(r => r.id));
  const walls: WallInfo[] = doc.walls.flatMap(w => {
    const from = pos.get(w.startVertexId), to = pos.get(w.endVertexId);
    if (!from || !to) return [];
    const sides = topology.wallSides.get(w.id);
    const faces = sides ? [sides.left, sides.right] : [];
    const rooms = [...new Set(faces.filter(f => roomIds.has(f)))];
    return [{
      id: w.id, lengthM: round(Math.hypot(to.x - from.x, to.y - from.y)), from, to,
      exterior: faces.some(f => !roomIds.has(f)), roomIds: rooms,
      openings: doc.openings.filter(o => o.wallId === w.id).map(o => ({ id: o.id, kind: o.openingKind, widthM: o.widthM, offsetM: round(o.offsetM) })),
    }];
  });
  // Rooms come from @egress/core so the agent, runner and UI agree on hashes and rule kinds (D73).
  const rooms: RoomInfo[] = describeRooms(doc).map(d => ({
    id: d.id, floorId: d.floorId, roomHash: d.roomHash, kind: labels?.get(d.roomHash) ?? d.ruleKind, areaM2: d.areaM2, widthM: d.widthM, lengthM: d.lengthM,
    center: d.center, wallIds: d.wallIds, neighbours: d.neighbours, openingIds: d.openingIds,
  }));
  return { rooms, walls };
}

export interface PlacementSpec {
  kind: OpeningKind;
  widthM?: number;
  wallId?: ID;
  offsetM?: number;
  at?: 'start' | 'center' | 'end';
  /** Limit candidate walls to this room's boundary. */
  roomId?: string;
  /** Put the opening as far as possible from this existing opening. */
  farthestFromOpeningId?: ID;
}

export interface Placement {
  command: Extract<EditCommand, { kind: 'createOpening' }>;
  wallId: ID;
  offsetM: number;
  center: Vec2;
  description: string;
}

const DEFAULT_WIDTH: Record<OpeningKind, number> = { door: 0.9, exit: 1.2, window: 1.2 };

/** Resolves a spatial request into one valid createOpening, or explains why it can't. */
export function resolvePlacement(doc: EgressDocument, spec: PlacementSpec): Placement {
  const { rooms, walls } = describeLayout(doc);
  const width = spec.widthM ?? DEFAULT_WIDTH[spec.kind];
  let candidates = walls;
  if (spec.wallId) candidates = walls.filter(w => w.id === spec.wallId);
  else if (spec.roomId) {
    const room = rooms.find(r => r.id === spec.roomId);
    if (!room) throw new DomainError('NOT_FOUND', `No room ${spec.roomId}; use a room id from inspect_layout.`);
    candidates = walls.filter(w => room.wallIds.includes(w.id));
  }
  // An exit needs an outside wall; a door is placed where it leads somewhere.
  if (spec.kind === 'exit') candidates = candidates.filter(w => w.exterior);
  if (!candidates.length) throw new DomainError('INVALID_INPUT', spec.kind === 'exit' ? 'No outside wall there for an exit.' : 'No wall matches that placement.');
  const reference = spec.farthestFromOpeningId ? doc.openings.find(o => o.id === spec.farthestFromOpeningId) : undefined;
  if (spec.farthestFromOpeningId && !reference) throw new DomainError('NOT_FOUND', `No opening ${spec.farthestFromOpeningId}.`);
  const refPoint = reference ? openingCenter(doc, reference) : null;

  let best: Placement | null = null, bestScore = -Infinity;
  for (const wall of candidates) {
    if (wall.lengthM < width + 0.2) continue;
    const lo = width / 2 + 0.1, hi = wall.lengthM - width / 2 - 0.1;
    const offsets = spec.offsetM !== undefined ? [Math.min(hi, Math.max(lo, spec.offsetM))]
      : spec.at === 'start' ? [lo] : spec.at === 'end' ? [hi] : spec.at === 'center' || !refPoint ? [wall.lengthM / 2]
      : Array.from({ length: 9 }, (_, i) => lo + (hi - lo) * i / 8);
    for (const offset of offsets) {
      const clash = wall.openings.some(o => Math.abs(o.offsetM - offset) < (o.widthM + width) / 2 + 0.1);
      if (clash) continue;
      const t = offset / wall.lengthM;
      const center = { x: wall.from.x + (wall.to.x - wall.from.x) * t, y: wall.from.y + (wall.to.y - wall.from.y) * t };
      const score = refPoint ? Math.hypot(center.x - refPoint.x, center.y - refPoint.y) : -Math.abs(offset - wall.lengthM / 2);
      if (score <= bestScore) continue;
      const command = { kind: 'createOpening' as const, wallId: wall.id, openingKind: spec.kind, offsetM: round(offset), widthM: width };
      if (!applyEdit(doc, { requestId: 'check', commands: [command] }).ok) continue;
      bestScore = score;
      const where = reference ? `${round(score)} m from ${reference.openingKind} ${reference.id}` : `at ${round(offset)} m along the wall`;
      best = { command, wallId: wall.id, offsetM: round(offset), center: { x: round(center.x), y: round(center.y) }, description: `A ${width} m ${spec.kind} on wall ${wall.id}${wall.exterior ? ' (outside wall)' : ''}, ${where}` };
    }
  }
  if (!best) throw new DomainError('INVALID_INPUT', `No room for a ${width} m ${spec.kind} there without overlapping another opening.`);
  return best;
}

export interface ComplianceCheck {
  id: string;
  title: string;
  status: 'pass' | 'fail';
  detail: string;
  entityIds: ID[];
}

/**
 * Modeled checks with typical code values (IBC-style): door clear width, exit count and
 * capacity for the head count, corridor width and the longest travel distance to an exit.
 * They are checks against reference numbers, not a code review.
 */
export function complianceChecks(doc: EgressDocument, occupants: number): ComplianceCheck[] {
  const checks: ComplianceCheck[] = [];
  const egress = doc.openings.filter(o => o.openingKind !== 'window');
  const narrow = egress.filter(o => o.widthM < 0.81);
  checks.push({
    id: 'door-width', title: 'Door and exit clear width ≥ 0.81 m', status: narrow.length ? 'fail' : 'pass',
    detail: narrow.length ? `${narrow.length} opening(s) narrower than 0.81 m: ${narrow.map(o => `${o.id} (${o.widthM} m)`).join(', ')}` : `All ${egress.length} doors and exits are at least 0.81 m wide.`,
    entityIds: narrow.map(o => o.id),
  });
  const exits = doc.openings.filter(o => o.openingKind === 'exit');
  const required = occupants <= 49 ? 1 : occupants <= 500 ? 2 : occupants <= 1000 ? 3 : 4;
  checks.push({
    id: 'exit-count', title: `Exits for ${occupants} people`, status: exits.length >= required ? 'pass' : 'fail',
    detail: `${exits.length} exit(s); ${required} needed for ${occupants} occupants.`, entityIds: exits.map(o => o.id),
  });
  const totalWidth = exits.reduce((s, o) => s + o.widthM, 0), neededWidth = round(occupants * 0.005);
  checks.push({
    id: 'exit-capacity', title: 'Total exit width ≥ 5 mm per occupant', status: totalWidth >= neededWidth ? 'pass' : 'fail',
    detail: `${round(totalWidth)} m of exits; ${neededWidth} m needed for ${occupants} occupants.`, entityIds: exits.map(o => o.id),
  });
  const halls = describeLayout(doc).rooms.filter(r => r.kind === 'hallway' && r.widthM < 1.12);
  checks.push({
    id: 'corridor-width', title: 'Corridor width ≥ 1.12 m', status: halls.length ? 'fail' : 'pass',
    detail: halls.length ? halls.map(r => `${r.id} is ${r.widthM} m wide`).join('; ') : 'Corridors are at least 1.12 m wide.', entityIds: halls.map(r => r.id),
  });
  try {
    const compiled = compileFloor(doc), { nav, grid } = compiled;
    let longest = 0;
    for (let i = 0; i < compiled.navigable.length; i++) {
      if (!compiled.navigable[i] || compiled.room[i] < 0) continue;
      const px = grid.origin.x + ((i % grid.width) + 0.5) * grid.cellSizeM, py = grid.origin.y + (Math.floor(i / grid.width) + 0.5) * grid.cellSizeM;
      let nearest = Infinity;
      for (let e = 0; e < compiled.exits.length; e++) nearest = Math.min(nearest, nav.distanceAt(e, px, py));
      if (Number.isFinite(nearest)) longest = Math.max(longest, nearest);
    }
    checks.push({
      id: 'travel-distance', title: 'Longest travel distance to an exit ≤ 61 m', status: longest <= 61 ? 'pass' : 'fail',
      detail: `The farthest point is ${round(longest)} m from its nearest exit.`, entityIds: [],
    });
  } catch { /* no walkable interior yet: nothing to measure */ }
  return checks;
}

/** Is a point inside the given room (for prompts that name a room by position)? */
export function roomAt(doc: EgressDocument, p: Vec2): string | null {
  const { topology } = deriveLayout(doc);
  return topology.rooms.find(r => pointInPolygon(p, r.polygon))?.id ?? null;
}
