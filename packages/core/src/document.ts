/**
 * EgressDocument helpers: construction, entity ⇄ document conversion (used by
 * the SpacetimeDB module to load/save `entities` rows), diffing, integrity.
 */
import { canonicalJson } from './canonical.ts';
import { DomainError } from './errors.ts';
import { distance, OPENING_END_CLEARANCE_M, signedArea } from './geometry.ts';
import type { EgressDocument, Entity, Floor, ID, Opening, Placeable, Slab, Stair, Vertex, Wall } from './types.ts';

export const DEFAULT_WALL = { thicknessM: 0.2, heightM: 2.8, material: 'normal' } as const;
export const DEFAULT_DOOR = { widthM: 0.9, sillHeightM: 0, openingHeightM: 2.1 } as const;
export const DEFAULT_WINDOW = { widthM: 1.2, sillHeightM: 0.9, openingHeightM: 1.2 } as const;
export const DEFAULT_EXIT = { widthM: 1.2, sillHeightM: 0, openingHeightM: 2.1 } as const;

export function emptyDocument(projectId: ID, floorId: ID = `${projectId}.floor0`): EgressDocument {
  const floor: Floor = { kind: 'floor', id: floorId, level: 0, name: 'Ground floor', elevationM: 0, ceilingHeightM: 3 };
  return { docVersion: 1, projectId, revision: 0, floors: [floor], vertices: [], walls: [], openings: [], slabs: [], stairs: [], placeables: [], furniture: [] };
}

/** Floors from the ground up (D75). Levels are unique; ids break ties in damaged documents. */
export function floorsByLevel(doc: EgressDocument): Floor[] {
  return [...doc.floors].sort((a, b) => a.level - b.level || (a.id < b.id ? -1 : 1));
}

/** The lowest floor's id: where exits to the outside are and where the simulation runs today. */
export function groundFloorId(doc: EgressDocument): ID {
  return floorsByLevel(doc)[0]?.id ?? '';
}

export function documentToEntities(doc: EgressDocument): Entity[] {
  return [...doc.floors, ...doc.vertices, ...doc.walls, ...doc.openings, ...(doc.slabs ?? []), ...(doc.stairs ?? []), ...(doc.placeables ?? [])];
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Build a document from unordered entity rows. Arrays are sorted by id so the result is deterministic. */
export function entitiesToDocument(projectId: ID, revision: number, entities: Iterable<Entity>): EgressDocument {
  const doc: EgressDocument = { docVersion: 1, projectId, revision, floors: [], vertices: [], walls: [], openings: [], slabs: [], stairs: [], placeables: [], furniture: [] };
  for (const e of entities) {
    if (e.kind === 'floor') doc.floors.push(e);
    else if (e.kind === 'vertex') doc.vertices.push(e);
    else if (e.kind === 'wall') doc.walls.push(e);
    else if (e.kind === 'slab') doc.slabs.push(e);
    else if (e.kind === 'stair') doc.stairs.push(e);
    else if (e.kind === 'placeable') doc.placeables.push(e);
    else doc.openings.push(e);
  }
  doc.floors.sort(byId); doc.vertices.sort(byId); doc.walls.sort(byId); doc.openings.sort(byId); doc.slabs.sort(byId); doc.stairs.sort(byId); doc.placeables.sort(byId);
  return doc;
}

export interface DocumentIndex {
  floors: Map<ID, Floor>;
  vertices: Map<ID, Vertex>;
  walls: Map<ID, Wall>;
  openings: Map<ID, Opening>;
  slabs: Map<ID, Slab>;
  stairs: Map<ID, Stair>;
  placeables: Map<ID, Placeable>;
}

export function indexDocument(doc: EgressDocument): DocumentIndex {
  return {
    floors: new Map(doc.floors.map(e => [e.id, e])),
    vertices: new Map(doc.vertices.map(e => [e.id, e])),
    walls: new Map(doc.walls.map(e => [e.id, e])),
    openings: new Map(doc.openings.map(e => [e.id, e])),
    slabs: new Map((doc.slabs ?? []).map(e => [e.id, e])),
    stairs: new Map((doc.stairs ?? []).map(e => [e.id, e])),
    placeables: new Map((doc.placeables ?? []).map(e => [e.id, e])),
  };
}

export function findEntity(index: DocumentIndex, id: ID): Entity | undefined {
  return index.floors.get(id) ?? index.vertices.get(id) ?? index.walls.get(id) ?? index.openings.get(id) ?? index.slabs.get(id) ?? index.stairs.get(id) ?? index.placeables.get(id);
}

export function wallLength(index: DocumentIndex, wall: Wall): number {
  const a = index.vertices.get(wall.startVertexId), b = index.vertices.get(wall.endVertexId);
  return a && b ? distance(a.position, b.position) : 0;
}

/** Entities to upsert and ids to delete so that `before` becomes `after`. */
export function diffDocuments(before: EgressDocument, after: EgressDocument): { put: Entity[]; remove: ID[] } {
  const old = new Map(documentToEntities(before).map(e => [e.id, e]));
  const put: Entity[] = [];
  const seen = new Set<ID>();
  for (const e of documentToEntities(after)) {
    seen.add(e.id);
    const prev = old.get(e.id);
    if (!prev || canonicalJson(prev) !== canonicalJson(e)) put.push(e);
  }
  const remove = [...old.keys()].filter(id => !seen.has(id));
  return { put, remove };
}

/**
 * Referential integrity and per-entity geometric validity. Throws a
 * DomainError for the first problem found. Run after every edit batch.
 */
export function assertDocumentIntegrity(doc: EgressDocument): void {
  const index = indexDocument(doc);
  const ids = new Set<ID>();
  for (const e of documentToEntities(doc)) {
    if (ids.has(e.id)) throw new DomainError('INVALID_GEOMETRY', `Duplicate entity id ${e.id}.`);
    ids.add(e.id);
  }
  for (const v of doc.vertices) {
    if (!index.floors.has(v.floorId)) throw new DomainError('INVALID_GEOMETRY', `Vertex ${v.id} is on a missing floor.`);
  }
  for (const w of doc.walls) {
    const a = index.vertices.get(w.startVertexId), b = index.vertices.get(w.endVertexId);
    if (!a || !b) throw new DomainError('INVALID_GEOMETRY', `Wall ${w.id} references a missing vertex.`);
    if (a.floorId !== w.floorId || b.floorId !== w.floorId) throw new DomainError('INVALID_GEOMETRY', `Wall ${w.id} spans floors.`);
    if (w.startVertexId === w.endVertexId) throw new DomainError('INVALID_GEOMETRY', `Wall ${w.id} has zero length.`);
  }
  for (const s of doc.slabs ?? []) {
    if (!index.floors.has(s.floorId)) throw new DomainError('INVALID_GEOMETRY', `Floor surface ${s.id} is on a missing floor.`);
    if (Math.abs(signedArea(s.polygon)) < 0.25) throw new DomainError('INVALID_GEOMETRY', 'A floor surface must cover at least 0.25 m².');
  }
  for (const p of doc.placeables ?? []) {
    if (!index.floors.has(p.floorId)) throw new DomainError('INVALID_GEOMETRY', `Placeable ${p.id} is on a missing floor.`);
  }
  for (const s of doc.stairs ?? []) {
    const from = index.floors.get(s.floorId), to = index.floors.get(s.toFloorId);
    if (!from || !to) throw new DomainError('INVALID_GEOMETRY', `Stair ${s.id} connects a missing floor.`);
    if (to.level !== from.level + 1) throw new DomainError('INVALID_GEOMETRY', 'A stair connects a floor to the floor directly above it.');
    if (s.max.x - s.min.x < 0.8 || s.max.y - s.min.y < 0.8) throw new DomainError('INVALID_GEOMETRY', 'A stair must be at least 0.8 m wide and long.');
  }
  const perWall = new Map<ID, Opening[]>();
  for (const o of doc.openings) {
    const wall = index.walls.get(o.wallId);
    if (!wall) throw new DomainError('OPENING_OUTSIDE_WALL', `Opening ${o.id} references a missing wall.`);
    if (o.floorId !== wall.floorId) throw new DomainError('INVALID_GEOMETRY', `Opening ${o.id} is on a different floor than its wall.`);
    const len = wallLength(index, wall);
    if (o.offsetM - o.widthM / 2 < OPENING_END_CLEARANCE_M - 1e-6 || o.offsetM + o.widthM / 2 > len - OPENING_END_CLEARANCE_M + 1e-6) {
      throw new DomainError('OPENING_OUTSIDE_WALL', `Opening ${o.id} does not fit inside its ${len.toFixed(2)} m wall.`);
    }
    const list = perWall.get(o.wallId) ?? [];
    list.push(o);
    perWall.set(o.wallId, list);
  }
  for (const [wallId, list] of perWall) {
    list.sort((a, b) => a.offsetM - b.offsetM);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1], cur = list[i];
      if (cur.offsetM - cur.widthM / 2 < prev.offsetM + prev.widthM / 2 + 1e-6) {
        throw new DomainError('INVALID_GEOMETRY', `Openings ${prev.id} and ${cur.id} overlap on wall ${wallId}.`);
      }
    }
  }
}
