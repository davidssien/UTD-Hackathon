/**
 * applyEdit: the one function that changes a building. It runs optimistically
 * in the browser and authoritatively inside the SpacetimeDB `applyEdit`
 * reducer, so it must stay pure and deterministic — no crypto, Date or
 * Math.random. New ids derive from the request id: `${requestId}.${n}`.
 * See Plan.md §4 (invariants) and D6/D19.
 *
 * Pass 0 scope: chains, boxes, erase, vertex moves, wall/opening updates,
 * deletes and patches. Pass 1 adds T-junction / crossing splits.
 */
import {
  assertDocumentIntegrity, DEFAULT_DOOR, DEFAULT_EXIT, DEFAULT_WINDOW, diffDocuments, documentToEntities, entitiesToDocument,
} from '../document.ts';
import { DomainError, type DomainErrorData } from '../errors.ts';
import {
  cross, distance, dot, MIN_WALL_LENGTH_M, normalize, segmentIntersection, sub, VERTEX_MERGE_M,
} from '../geometry.ts';
import type { EditCommand, EgressDocument, Entity, Floor, ID, Opening, Vec2, Vertex, Wall, WallMaterial } from '../types.ts';

export type PatchCommand = Extract<EditCommand, { kind: 'applyPatch' }>;

export type ApplyEditResult =
  | {
      ok: true;
      doc: EgressDocument;
      /** created[i] = ids of entities created by command i (in creation order). */
      created: ID[][];
      /** Ids of entities that existed before and were modified. */
      changed: ID[];
      removed: ID[];
      /** Applying this patch to `doc` restores the input document. */
      inverse: PatchCommand;
    }
  | { ok: false; error: DomainErrorData };

export interface ApplyEditInput {
  requestId: ID;
  commands: EditCommand[];
}

export function applyEdit(doc: EgressDocument, request: ApplyEditInput): ApplyEditResult {
  try {
    const ws = new Working(doc, request.requestId);
    const created: ID[][] = [];
    for (const command of request.commands) {
      ws.created = [];
      apply(ws, command);
      created.push(ws.created);
    }
    ws.removeOrphanVertices();
    let next = entitiesToDocument(doc.projectId, doc.revision, ws.entities());
    assertDocumentIntegrity(next);

    const diff = diffDocuments(doc, next);
    if (diff.put.length || diff.remove.length) next = { ...next, revision: doc.revision + 1 };
    const before = new Map(documentToEntities(doc).map(e => [e.id, e]));
    const changed = diff.put.filter(e => before.has(e.id)).map(e => e.id);
    const createdIds = diff.put.filter(e => !before.has(e.id)).map(e => e.id);
    const inverse: PatchCommand = {
      kind: 'applyPatch',
      put: [...changed, ...diff.remove].map(id => before.get(id)!),
      remove: createdIds,
    };
    return { ok: true, doc: next, created, changed, removed: diff.remove, inverse };
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, error: e.toJSON() };
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: e instanceof Error ? e.message : String(e) } };
  }
}

/** Like applyEdit but throws DomainError on failure. Convenient in reducers and tests. */
export function applyEditOrThrow(doc: EgressDocument, request: ApplyEditInput) {
  const result = applyEdit(doc, request);
  if (!result.ok) throw new DomainError(result.error.code, result.error.message, result.error.details);
  return result;
}

// ── Mutable working copy ────────────────────────────────────────────────────

type WallStyle = { thicknessM: number; heightM: number; material: WallMaterial };

class Working {
  floors: Map<ID, Floor>;
  vertices: Map<ID, Vertex>;
  walls: Map<ID, Wall>;
  openings: Map<ID, Opening>;
  created: ID[] = [];
  private readonly requestId: ID;
  private counter = 0;

  constructor(doc: EgressDocument, requestId: ID) {
    this.requestId = requestId;
    this.floors = new Map(doc.floors.map(e => [e.id, e]));
    this.vertices = new Map(doc.vertices.map(e => [e.id, e]));
    this.walls = new Map(doc.walls.map(e => [e.id, e]));
    this.openings = new Map(doc.openings.map(e => [e.id, e]));
  }

  entities(): Entity[] {
    return [...this.floors.values(), ...this.vertices.values(), ...this.walls.values(), ...this.openings.values()];
  }

  nextId(): ID {
    const id = `${this.requestId}.${this.counter++}`;
    this.created.push(id);
    return id;
  }

  find(id: ID): Entity | undefined {
    return this.floors.get(id) ?? this.vertices.get(id) ?? this.walls.get(id) ?? this.openings.get(id);
  }

  floor(id: ID): Floor {
    const floor = this.floors.get(id);
    if (!floor) throw new DomainError('NOT_FOUND', `Floor ${id} does not exist.`);
    return floor;
  }

  wall(id: ID): Wall {
    const wall = this.walls.get(id);
    if (!wall) throw new DomainError('NOT_FOUND', `Wall ${id} does not exist.`);
    return wall;
  }

  position(vertexId: ID): Vec2 {
    const v = this.vertices.get(vertexId);
    if (!v) throw new DomainError('NOT_FOUND', `Vertex ${vertexId} does not exist.`);
    return v.position;
  }

  /** Reuse a vertex within VERTEX_MERGE_M on the same floor, else create one. */
  vertexAt(floorId: ID, p: Vec2): ID {
    let best: Vertex | undefined;
    let bestDistance = VERTEX_MERGE_M;
    for (const v of this.vertices.values()) {
      if (v.floorId !== floorId) continue;
      const d = distance(v.position, p);
      if (d <= bestDistance) { best = v; bestDistance = d; }
    }
    if (best) return best.id;
    const id = this.nextId();
    this.vertices.set(id, { kind: 'vertex', id, floorId, position: { x: p.x, y: p.y } });
    return id;
  }

  addWall(floorId: ID, startVertexId: ID, endVertexId: ID, style: WallStyle): ID {
    if (startVertexId === endVertexId) throw new DomainError('INVALID_GEOMETRY', 'Walls need two different endpoints.');
    const a = this.position(startVertexId), b = this.position(endVertexId);
    if (distance(a, b) < MIN_WALL_LENGTH_M - 1e-9) throw new DomainError('INVALID_GEOMETRY', `Walls must be at least ${MIN_WALL_LENGTH_M} m long.`);
    for (const w of this.walls.values()) {
      if (w.floorId !== floorId) continue;
      const same = (w.startVertexId === startVertexId && w.endVertexId === endVertexId) || (w.startVertexId === endVertexId && w.endVertexId === startVertexId);
      if (same) throw new DomainError('INVALID_GEOMETRY', 'A wall already exists here.', { wallId: w.id });
      if (collinearOverlap(a, b, this.position(w.startVertexId), this.position(w.endVertexId))) {
        throw new DomainError('INVALID_GEOMETRY', 'This wall would overlap an existing wall.', { wallId: w.id });
      }
    }
    // TODO(Pass 1): split walls at T-junctions and crossings so the graph stays planar.
    const id = this.nextId();
    this.walls.set(id, { kind: 'wall', id, floorId, startVertexId, endVertexId, ...style });
    return id;
  }

  deleteOpening(id: ID) {
    this.openings.delete(id);
  }

  deleteWall(id: ID) {
    for (const o of [...this.openings.values()]) if (o.wallId === id) this.openings.delete(o.id);
    this.walls.delete(id);
  }

  deleteVertex(id: ID) {
    for (const w of [...this.walls.values()]) if (w.startVertexId === id || w.endVertexId === id) this.deleteWall(w.id);
    this.vertices.delete(id);
  }

  deleteFloor(id: ID) {
    for (const v of [...this.vertices.values()]) if (v.floorId === id) this.deleteVertex(v.id);
    for (const o of [...this.openings.values()]) if (o.floorId === id) this.openings.delete(o.id);
    this.floors.delete(id);
  }

  /** Cascading delete. Returns false when the id is unknown. */
  delete(id: ID): boolean {
    const e = this.find(id);
    if (!e) return false;
    if (e.kind === 'floor') this.deleteFloor(id);
    else if (e.kind === 'vertex') this.deleteVertex(id);
    else if (e.kind === 'wall') this.deleteWall(id);
    else this.deleteOpening(id);
    return true;
  }

  put(e: Entity) {
    const existing = this.find(e.id);
    if (existing && existing.kind !== e.kind) throw new DomainError('INVALID_INPUT', `Entity ${e.id} cannot change kind from ${existing.kind} to ${e.kind}.`);
    if (!existing) this.created.push(e.id);
    if (e.kind === 'floor') this.floors.set(e.id, e);
    else if (e.kind === 'vertex') this.vertices.set(e.id, e);
    else if (e.kind === 'wall') this.walls.set(e.id, e);
    else this.openings.set(e.id, e);
  }

  removeOrphanVertices() {
    const used = new Set<ID>();
    for (const w of this.walls.values()) { used.add(w.startVertexId); used.add(w.endVertexId); }
    for (const id of [...this.vertices.keys()]) if (!used.has(id)) this.vertices.delete(id);
  }
}

function collinearOverlap(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const dir = normalize(sub(b, a));
  const off = (p: Vec2) => Math.abs(cross(dir, sub(p, a)));
  if (off(c) > VERTEX_MERGE_M || off(d) > VERTEX_MERGE_M) return false;
  const len = distance(a, b);
  const tc = dot(sub(c, a), dir), td = dot(sub(d, a), dir);
  const lo = Math.max(0, Math.min(tc, td)), hi = Math.min(len, Math.max(tc, td));
  return hi - lo > VERTEX_MERGE_M;
}

// ── Command handlers ────────────────────────────────────────────────────────

function apply(ws: Working, command: EditCommand): void {
  switch (command.kind) {
    case 'createWallChain': {
      ws.floor(command.floorId);
      const style = { thicknessM: command.thicknessM, heightM: command.heightM, material: command.material };
      const ids: ID[] = [];
      for (const p of command.points) {
        const id = ws.vertexAt(command.floorId, p);
        if (ids[ids.length - 1] !== id) ids.push(id);
      }
      if (ids.length < 2) throw new DomainError('INVALID_GEOMETRY', `Walls must be at least ${MIN_WALL_LENGTH_M} m long.`);
      for (let i = 1; i < ids.length; i++) ws.addWall(command.floorId, ids[i - 1], ids[i], style);
      return;
    }
    case 'createBox': {
      ws.floor(command.floorId);
      const x0 = Math.min(command.min.x, command.max.x), x1 = Math.max(command.min.x, command.max.x);
      const y0 = Math.min(command.min.y, command.max.y), y1 = Math.max(command.min.y, command.max.y);
      if (x1 - x0 < MIN_WALL_LENGTH_M || y1 - y0 < MIN_WALL_LENGTH_M) throw new DomainError('INVALID_GEOMETRY', `Boxes must be at least ${MIN_WALL_LENGTH_M} m on each side.`);
      const style = { thicknessM: command.thicknessM, heightM: command.heightM, material: command.material };
      // Counter-clockwise from the south-west corner.
      const corners = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }].map(p => ws.vertexAt(command.floorId, p));
      for (let i = 0; i < 4; i++) ws.addWall(command.floorId, corners[i], corners[(i + 1) % 4], style);
      return;
    }
    case 'eraseByLine': {
      ws.floor(command.floorId);
      for (const w of [...ws.walls.values()]) {
        if (w.floorId !== command.floorId) continue;
        if (segmentIntersection(ws.position(w.startVertexId), ws.position(w.endVertexId), command.from, command.to)) ws.deleteWall(w.id);
      }
      return;
    }
    case 'moveVertex': {
      const v = ws.vertices.get(command.vertexId);
      if (!v) throw new DomainError('NOT_FOUND', `Vertex ${command.vertexId} does not exist.`);
      for (const other of ws.vertices.values()) {
        if (other.id !== v.id && other.floorId === v.floorId && distance(other.position, command.to) <= VERTEX_MERGE_M) {
          // TODO(Pass 1): merge vertices instead of rejecting.
          throw new DomainError('INVALID_GEOMETRY', 'Moving onto another corner is not supported yet.');
        }
      }
      ws.vertices.set(v.id, { ...v, position: { x: command.to.x, y: command.to.y } });
      for (const w of ws.walls.values()) {
        if (w.startVertexId !== v.id && w.endVertexId !== v.id) continue;
        if (distance(ws.position(w.startVertexId), ws.position(w.endVertexId)) < MIN_WALL_LENGTH_M - 1e-9) {
          throw new DomainError('INVALID_GEOMETRY', `Walls must be at least ${MIN_WALL_LENGTH_M} m long.`, { wallId: w.id });
        }
      }
      return;
    }
    case 'updateWall': {
      const wall = ws.wall(command.wallId);
      ws.walls.set(wall.id, { ...wall, ...definedOnly(command.patch) });
      return;
    }
    case 'createOpening': {
      const wall = ws.wall(command.wallId);
      const defaults = command.openingKind === 'door' ? DEFAULT_DOOR : command.openingKind === 'window' ? DEFAULT_WINDOW : DEFAULT_EXIT;
      const id = ws.nextId();
      ws.openings.set(id, {
        kind: 'opening',
        id,
        floorId: wall.floorId,
        wallId: wall.id,
        openingKind: command.openingKind,
        offsetM: command.offsetM,
        widthM: command.widthM,
        sillHeightM: command.sillHeightM ?? defaults.sillHeightM,
        openingHeightM: command.openingHeightM ?? defaults.openingHeightM,
        state: command.state ?? (command.openingKind === 'window' ? 'closed' : 'open'),
      });
      return;
    }
    case 'updateOpening': {
      const opening = ws.openings.get(command.openingId);
      if (!opening) throw new DomainError('NOT_FOUND', `Opening ${command.openingId} does not exist.`);
      ws.openings.set(opening.id, { ...opening, ...definedOnly(command.patch) });
      return;
    }
    case 'deleteEntities': {
      for (const id of command.ids) if (!ws.delete(id)) throw new DomainError('NOT_FOUND', `Entity ${id} does not exist.`);
      return;
    }
    case 'applyPatch': {
      // Missing ids are ignored so undo/redo stays idempotent.
      for (const id of command.remove) ws.delete(id);
      for (const e of command.put) ws.put(e);
      return;
    }
  }
}

function definedOnly<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}
