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
  cross, distance, dot, MIN_WALL_LENGTH_M, normalize, OPENING_END_CLEARANCE_M, projectOnSegment, segmentIntersection, sub, VERTEX_MERGE_M,
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

  /**
   * Draw a wall from a to b. Stretches already covered by a collinear wall are
   * reused rather than duplicated (D25), so boxes can share sides; the rest
   * become new walls. Junctions are resolved afterwards by `planarize`.
   */
  addWallSpan(floorId: ID, a: Vec2, b: Vec2, style: WallStyle): void {
    const len = distance(a, b);
    const dir = normalize(sub(b, a));
    const covered: [number, number][] = [];
    for (const w of this.walls.values()) {
      if (w.floorId !== floorId) continue;
      const c = this.position(w.startVertexId), d = this.position(w.endVertexId);
      if (!collinear(a, dir, c) || !collinear(a, dir, d)) continue;
      const tc = dot(sub(c, a), dir), td = dot(sub(d, a), dir);
      const lo = Math.max(0, Math.min(tc, td)), hi = Math.min(len, Math.max(tc, td));
      if (hi - lo > VERTEX_MERGE_M) covered.push([lo, hi]);
    }
    covered.sort((p, q) => p[0] - q[0]);
    let cursor = 0;
    const at = (t: number) => ({ x: a.x + dir.x * t, y: a.y + dir.y * t });
    for (const [lo, hi] of [...covered, [len, len] as [number, number]]) {
      if (lo - cursor > VERTEX_MERGE_M) this.addWall(floorId, this.vertexAt(floorId, at(cursor)), this.vertexAt(floorId, at(lo)), style);
      cursor = Math.max(cursor, hi);
    }
  }

  addWall(floorId: ID, startVertexId: ID, endVertexId: ID, style: WallStyle): ID {
    if (startVertexId === endVertexId) throw new DomainError('INVALID_GEOMETRY', 'Walls need two different endpoints.');
    const id = this.nextId();
    this.walls.set(id, { kind: 'wall', id, floorId, startVertexId, endVertexId, ...style });
    return id;
  }

  /**
   * Keep the floor's wall graph planar (Plan.md §4): split walls wherever a
   * vertex lies on a wall's interior (T-junction) or two walls cross.
   */
  planarize(floorId: ID): void {
    for (let i = 0; i < 10_000; i++) if (!this.splitOnce(floorId)) return;
    throw new DomainError('INTERNAL_ERROR', 'Wall graph did not settle while splitting intersections.');
  }

  private splitOnce(floorId: ID): boolean {
    const walls = [...this.walls.values()].filter(w => w.floorId === floorId);
    const vertices = [...this.vertices.values()].filter(v => v.floorId === floorId);
    for (const w of walls) {
      const a = this.position(w.startVertexId), b = this.position(w.endVertexId);
      const len = distance(a, b);
      for (const v of vertices) {
        if (v.id === w.startVertexId || v.id === w.endVertexId) continue;
        const hit = projectOnSegment(v.position, a, b);
        const along = hit.t * len;
        if (hit.distance <= VERTEX_MERGE_M && along > VERTEX_MERGE_M && len - along > VERTEX_MERGE_M) {
          this.splitWall(w.id, v.id);
          return true;
        }
      }
    }
    for (let i = 0; i < walls.length; i++) {
      for (let j = i + 1; j < walls.length; j++) {
        const w = walls[i], u = walls[j];
        if (w.startVertexId === u.startVertexId || w.startVertexId === u.endVertexId || w.endVertexId === u.startVertexId || w.endVertexId === u.endVertexId) continue;
        const a = this.position(w.startVertexId), b = this.position(w.endVertexId);
        const c = this.position(u.startVertexId), d = this.position(u.endVertexId);
        const hit = segmentIntersection(a, b, c, d);
        if (!hit) continue;
        const lw = distance(a, b), lu = distance(c, d);
        const interior = (t: number, len: number) => t * len > VERTEX_MERGE_M && (1 - t) * len > VERTEX_MERGE_M;
        if (!interior(hit.t, lw) || !interior(hit.u, lu)) continue; // endpoint touches are handled above
        const vertexId = this.vertexAt(floorId, hit.point);
        this.splitWall(w.id, vertexId);
        this.splitWall(u.id, vertexId);
        return true;
      }
    }
    return false;
  }

  /** Split a wall at a vertex on it. The first piece keeps the id; openings move to the piece holding their center. */
  splitWall(wallId: ID, vertexId: ID): void {
    const w = this.wall(wallId);
    const at = distance(this.position(w.startVertexId), this.position(vertexId));
    for (const o of this.openings.values()) {
      if (o.wallId !== w.id) continue;
      const lo = o.offsetM - o.widthM / 2, hi = o.offsetM + o.widthM / 2;
      if (lo < at + OPENING_END_CLEARANCE_M && hi > at - OPENING_END_CLEARANCE_M) {
        throw new DomainError('INVALID_GEOMETRY', `Walls cannot meet inside or right next to a ${o.openingKind}.`, { openingId: o.id, wallId: w.id });
      }
    }
    const second = this.nextId();
    this.walls.set(w.id, { ...w, endVertexId: vertexId });
    this.walls.set(second, { ...w, id: second, startVertexId: vertexId });
    for (const o of [...this.openings.values()]) {
      if (o.wallId === w.id && o.offsetM > at) this.openings.set(o.id, { ...o, wallId: second, offsetM: o.offsetM - at });
    }
  }

  /** Merge vertex `from` into `into`: rewire walls, drop walls that collapse or duplicate. */
  mergeVertex(from: ID, into: ID): void {
    for (const w of [...this.walls.values()]) {
      if (w.startVertexId !== from && w.endVertexId !== from) continue;
      const start = w.startVertexId === from ? into : w.startVertexId;
      const end = w.endVertexId === from ? into : w.endVertexId;
      if (start === end) { this.deleteWall(w.id); continue; }
      const twin = [...this.walls.values()].find(x => x.id !== w.id && ((x.startVertexId === start && x.endVertexId === end) || (x.startVertexId === end && x.endVertexId === start)));
      if (twin) {
        if ([...this.openings.values()].some(o => o.wallId === w.id)) {
          throw new DomainError('INVALID_GEOMETRY', 'Merging these corners would stack a wall that has openings onto another wall.', { wallId: w.id });
        }
        this.deleteWall(w.id);
        continue;
      }
      this.walls.set(w.id, { ...w, startVertexId: start, endVertexId: end });
    }
    this.vertices.delete(from);
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

/** Is p on the infinite line through a with unit direction dir? */
const collinear = (a: Vec2, dir: Vec2, p: Vec2) => Math.abs(cross(dir, sub(p, a))) <= VERTEX_MERGE_M;

/** Smallest wall piece a move may leave behind (splits can create pieces shorter than MIN_WALL_LENGTH_M). */
const MIN_PIECE_M = 0.05;

// ── Command handlers ────────────────────────────────────────────────────────

function apply(ws: Working, command: EditCommand): void {
  switch (command.kind) {
    case 'createWallChain': {
      ws.floor(command.floorId);
      const style = { thicknessM: command.thicknessM, heightM: command.heightM, material: command.material };
      const points = command.points.filter((p, i) => i === 0 || distance(p, command.points[i - 1]) > VERTEX_MERGE_M);
      if (points.length < 2) throw new DomainError('INVALID_GEOMETRY', `Walls must be at least ${MIN_WALL_LENGTH_M} m long.`);
      for (let i = 1; i < points.length; i++) {
        if (distance(points[i - 1], points[i]) < MIN_WALL_LENGTH_M - 1e-9) throw new DomainError('INVALID_GEOMETRY', `Walls must be at least ${MIN_WALL_LENGTH_M} m long.`);
      }
      for (let i = 1; i < points.length; i++) ws.addWallSpan(command.floorId, points[i - 1], points[i], style);
      ws.planarize(command.floorId);
      return;
    }
    case 'createBox': {
      ws.floor(command.floorId);
      const x0 = Math.min(command.min.x, command.max.x), x1 = Math.max(command.min.x, command.max.x);
      const y0 = Math.min(command.min.y, command.max.y), y1 = Math.max(command.min.y, command.max.y);
      if (x1 - x0 < MIN_WALL_LENGTH_M || y1 - y0 < MIN_WALL_LENGTH_M) throw new DomainError('INVALID_GEOMETRY', `Boxes must be at least ${MIN_WALL_LENGTH_M} m on each side.`);
      const style = { thicknessM: command.thicknessM, heightM: command.heightM, material: command.material };
      // Counter-clockwise from the south-west corner.
      const corners = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
      for (let i = 0; i < 4; i++) ws.addWallSpan(command.floorId, corners[i], corners[(i + 1) % 4], style);
      ws.planarize(command.floorId);
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
      ws.vertices.set(v.id, { ...v, position: { x: command.to.x, y: command.to.y } });
      const target = [...ws.vertices.values()].find(o => o.id !== v.id && o.floorId === v.floorId && distance(o.position, command.to) <= VERTEX_MERGE_M);
      if (target) {
        ws.mergeVertex(v.id, target.id);
      } else {
        for (const w of ws.walls.values()) {
          if (w.startVertexId !== v.id && w.endVertexId !== v.id) continue;
          if (distance(ws.position(w.startVertexId), ws.position(w.endVertexId)) < MIN_PIECE_M) {
            throw new DomainError('INVALID_GEOMETRY', 'That move would shrink a wall to nothing.', { wallId: w.id });
          }
        }
      }
      ws.planarize(v.floorId);
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
