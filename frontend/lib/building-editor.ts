import { mergeImport } from './sketch-import.ts';
import { polygonArea, roomAt } from './rooms.ts';
import { getFloorBounds } from './floorplan.ts';
import type { Building, Wall } from './floorplan';

export type Point = { x: number; z: number };
export type Tool = 'select' | 'wall' | 'floor' | 'fill-floor' | 'door' | 'window' | 'delete';
export type Opening = { id: string; type: 'door' | 'window'; offset: number; width: number; height: number; sill: number };
export type EditCommand =
  | { type: 'import'; building: Building; append: boolean }
  | { type: 'invalid'; reason: string }
  | { type: 'floor'; start: Point; end: Point }
  | { type: 'fill-floor'; point: Point }
  | { type: 'delete-base-floor' }
  | { type: 'delete-floor'; floorId: string }
  | { type: 'resize-wall'; wallId: string; endpoint: 'start' | 'end'; point: Point }
  | { type: 'wall'; start: Point; end: Point }
  | { type: 'opening'; wallId: string; kind: 'door' | 'window'; point: Point }
  | { type: 'delete-walls'; wallIds: string[] }
  | { type: 'delete'; wallId: string; openingId?: string };

// Weld tiny recognition gaps at corners before the first edit. Keep walls with
// openings untouched so their measured offsets remain stable.
export function joinWallEndpoints(walls: Wall[]): Wall[] {
  const result = walls.map(w => ({ ...w }));
  const ends = result.flatMap(w => (['start', 'end'] as const).map(end => ({ w, end })));
  const used = new Set<number>();
  const position = (e: typeof ends[number]) => e.end === 'start' ? { x: e.w.x1, z: e.w.z1 } : { x: e.w.x2, z: e.w.z2 };
  for (let i = 0; i < ends.length; i++) {
    if (used.has(i) || ends[i].w.openings?.length) continue;
    const a = position(ends[i]);
    const cluster = [i];
    for (let j = i+1; j < ends.length; j++) {
      if (used.has(j) || ends[j].w === ends[i].w || ends[j].w.openings?.length) continue;
      const b = position(ends[j]);
      if (Math.hypot(a.x-b.x,a.z-b.z) <= .3) cluster.push(j);
    }
    if (cluster.length < 2) continue;
    const center = cluster.reduce((p,k) => { const q = position(ends[k]); return { x: p.x+q.x/cluster.length, z: p.z+q.z/cluster.length }; }, { x: 0, z: 0 });
    for (const k of cluster) {
      const { w, end } = ends[k]; used.add(k);
      if (end === 'start') { w.x1 = center.x; w.z1 = center.z; }
      else { w.x2 = center.x; w.z2 = center.z; }
    }
  }
  return result;
}

export const wallLength = (wall: Wall) => Math.hypot(wall.x2 - wall.x1, wall.z2 - wall.z1);

export function snapPoint(point: Point, walls: Wall[]): Point {
  let best: Point | null = null;
  let distance = .3;
  for (const wall of walls) for (const p of [{ x: wall.x1, z: wall.z1 }, { x: wall.x2, z: wall.z2 }]) {
    const d = Math.hypot(point.x - p.x, point.z - p.z);
    if (d < distance) { best = p; distance = d; }
  }
  return best ?? { x: Math.round(point.x * 2) / 2, z: Math.round(point.z * 2) / 2 };
}

export function wallEnd(start: Point, point: Point, walls: Wall[], free = false): Point {
  const end = snapPoint(point, walls);
  if (free) return end;
  return Math.abs(end.x - start.x) >= Math.abs(end.z - start.z) ? { x: end.x, z: start.z } : { x: start.x, z: end.z };
}

export function projectOnWall(wall: Wall, point: Point) {
  const length = wallLength(wall);
  const dx = (wall.x2 - wall.x1) / (length || 1), dz = (wall.z2 - wall.z1) / (length || 1);
  const offset = Math.max(0, Math.min(length, (point.x - wall.x1) * dx + (point.z - wall.z1) * dz));
  const projected = { x: wall.x1 + dx * offset, z: wall.z1 + dz * offset };
  return { ...projected, offset, distance: Math.hypot(point.x - projected.x, point.z - projected.z) };
}

export function nearestWall(walls: Wall[], point: Point, maxDistance = .65): Wall | undefined {
  let best: Wall | undefined;
  for (const wall of walls) {
    const d = projectOnWall(wall, point).distance;
    if (d < maxDistance) { best = wall; maxDistance = d; }
  }
  return best;
}

export function openingAt(wall: Wall, kind: 'door' | 'window', point: Point): { opening?: Opening; error?: string } {
  const width = kind === 'door' ? .9 : 1.2;
  const length = wallLength(wall);
  if (length < width + .2) return { error: 'Choose a longer wall for this opening.' };
  const raw = projectOnWall(wall, point).offset;
  const offset = Math.max(width / 2 + .1, Math.min(length - width / 2 - .1, Math.round(raw * 4) / 4));
  if ((wall.openings ?? []).some(o => Math.abs(o.offset - offset) < (o.width + width) / 2 + .1)) return { error: 'This opening overlaps an existing door or window.' };
  return { opening: { id: '', type: kind, offset, width, height: kind === 'door' ? 2.1 : 1.2, sill: kind === 'door' ? 0 : .9 } };
}

export function editBuilding(building: Building, command: EditCommand): { building: Building; error?: string } {
  if (command.type === 'import') return command.append ? mergeImport(building, command.building) : { building: command.building };
  if (command.type === 'invalid') return { building, error: command.reason };
  const floorBounds = getFloorBounds(building);
  if (command.type === 'delete-base-floor') return { building: floorBounds ? { ...building, floorBounds: null } : building };
  if (command.type === 'resize-wall') {
    const target = building.walls.find(w => w.id === command.wallId);
    if (!target) return { building };
    const old = command.endpoint === 'start' ? { x: target.x1, z: target.z1 } : { x: target.x2, z: target.z2 };
    const point = snapPoint(command.point, building.walls.filter(w => w.id !== target.id));
    if (![point.x, point.z].every(Number.isFinite)) return { building, error: 'Choose a valid grid point.' };
    if (Math.hypot(point.x - old.x, point.z - old.z) < .001) return { building };
    const walls = building.walls.map(w => {
      const start = Math.hypot(w.x1 - old.x, w.z1 - old.z) < .001;
      const end = Math.hypot(w.x2 - old.x, w.z2 - old.z) < .001;
      return start || end ? { ...w, x1: start ? point.x : w.x1, z1: start ? point.z : w.z1, x2: end ? point.x : w.x2, z2: end ? point.z : w.z2 } : w;
    });
    for (const w of walls) {
      if (w === building.walls.find(v => v.id === w.id)) continue;
      const remaining = walls.filter(v => v.id !== w.id);
      const check = editBuilding({ ...building, walls: remaining }, { type: 'wall', start: { x: w.x1, z: w.z1 }, end: { x: w.x2, z: w.z2 } });
      if (check.error) return { building, error: check.error };
      if ((w.openings ?? []).some(o => o.offset + o.width / 2 + .1 > wallLength(w))) return { building, error: 'Move or delete the opening before shortening this wall.' };
    }
    return { building: { ...building, floorBounds, walls } };
  }

  if (command.type === 'delete-floor') {
    const floors = (building.floors ?? []).filter(f => f.id !== command.floorId);
    return { building: floors.length === (building.floors ?? []).length ? building : { ...building, floorBounds, floors } };
  }
  if (command.type === 'floor' && (Math.abs(command.end.x - command.start.x) < .5 || Math.abs(command.end.z - command.start.z) < .5)) return { building, error: 'Draw a floor at least 0.5 m wide and deep.' };
  if (command.type === 'floor' || command.type === 'fill-floor') {
    const points = command.type === 'fill-floor' ? roomAt(building.walls, command.point) : floorRectangle(command.start, command.end);
    if (!points) return { building, error: 'This space is not enclosed. Close the wall gaps before filling the room.' };
    if (points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.z)) || polygonArea(points) < .25) return { building, error: 'Draw a floor at least 0.5 m wide and deep.' };
    const key = (p: Point[]) => p.map(v => `${v.x.toFixed(4)},${v.z.toFixed(4)}`).sort().join(';');
    if ((building.floors ?? []).some(f => key(f.points) === key(points))) return { building, error: 'A floor already covers this area.' };
    return { building: { ...building, floorBounds, floors: [...(building.floors ?? []), { id: crypto.randomUUID(), points, kind: command.type === 'floor' ? 'drawn' : 'room' }] } };
  }
  if (command.type === 'delete-walls') {
    const ids = new Set(command.wallIds);
    const walls = building.walls.filter(w => !ids.has(w.id));
    return { building: walls.length === building.walls.length ? building : { ...building, floorBounds, walls } };
  }
  if (command.type === 'wall') {
    const { start, end } = command;
    if (![start.x, start.z, end.x, end.z].every(Number.isFinite)) return { building, error: 'Choose a valid point on the grid.' };
    if (Math.hypot(end.x - start.x, end.z - start.z) < .5) return { building, error: 'Walls must be at least 0.5 m long.' };
    const duplicate = building.walls.some(w =>
      (Math.hypot(w.x1 - start.x, w.z1 - start.z) < .05 && Math.hypot(w.x2 - end.x, w.z2 - end.z) < .05) ||
      (Math.hypot(w.x1 - end.x, w.z1 - end.z) < .05 && Math.hypot(w.x2 - start.x, w.z2 - start.z) < .05));
    if (duplicate) return { building, error: 'A wall already exists here.' };
    const length = Math.hypot(end.x - start.x, end.z - start.z);
    const dx = (end.x - start.x) / length, dz = (end.z - start.z) / length;
    const overlaps = building.walls.some(w => {
      const a = (w.x1 - start.x) * dx + (w.z1 - start.z) * dz;
      const b = (w.x2 - start.x) * dx + (w.z2 - start.z) * dz;
      const distanceA = Math.abs((w.x1 - start.x) * dz - (w.z1 - start.z) * dx);
      const distanceB = Math.abs((w.x2 - start.x) * dz - (w.z2 - start.z) * dx);
      return distanceA < .05 && distanceB < .05 && Math.min(length, Math.max(a, b)) - Math.max(0, Math.min(a, b)) > .05;
    });
    if (overlaps) return { building, error: 'This wall would overlap an existing wall.' };

    const connected = nearestWall(building.walls, start, .31) ?? nearestWall(building.walls, end, .31);
    return { building: { ...building, floorBounds, walls: [...building.walls, { id: crypto.randomUUID(), x1: start.x, z1: start.z, x2: end.x, z2: end.z, thickness: connected?.thickness ?? .2 }] } };
  }
  const wall = building.walls.find(w => w.id === command.wallId);
  if (!wall) return { building };
  if (command.type === 'delete') {
    return { building: { ...building, floorBounds, walls: command.openingId
      ? building.walls.map(w => w.id === wall.id ? { ...w, openings: (w.openings ?? []).filter(o => o.id !== command.openingId) } : w)
      : building.walls.filter(w => w.id !== wall.id) } };
  }
  const result = openingAt(wall, command.kind, command.point);
  if (!result.opening) return { building, error: result.error };
  return { building: { ...building, floorBounds, walls: building.walls.map(w => w.id === wall.id ? { ...w, openings: [...(w.openings ?? []), { ...result.opening!, id: crypto.randomUUID() }] } : w) } };
}

// Solid wall sections around actual door/window voids, in local wall coordinates.
export function wallSections(wall: Wall, height: number) {
  const length = wallLength(wall);
  const pieces: { center: number; bottom: number; width: number; height: number }[] = [];
  let cursor = 0;
  const add = (start: number, end: number, bottom: number, top: number) => {
    if (end - start > .001 && top - bottom > .001) pieces.push({ center: (start + end) / 2 - length / 2, bottom, width: end - start, height: top - bottom });
  };
  for (const o of [...(wall.openings ?? [])].sort((a, b) => a.offset - b.offset)) {
    const start = Math.max(cursor, o.offset - o.width / 2), end = Math.min(length, o.offset + o.width / 2);
    add(cursor, start, 0, height);
    add(start, end, 0, Math.min(o.sill, height));
    add(start, end, Math.min(o.sill + o.height, height), height);
    cursor = end;
  }
  add(cursor, length, 0, height);
  return pieces;
}

export type EditorState = { present: Building | null; past: Building[]; future: Building[]; error: string };
export type EditorAction = { type: 'load'; building: Building | null } | { type: 'edit'; command: EditCommand } | { type: 'undo' } | { type: 'redo' } | { type: 'clear-error' };
export const initialEditor: EditorState = { present: null, past: [], future: [], error: '' };
export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  if (action.type === 'load') return { ...initialEditor, present: action.building ? { ...action.building, walls: joinWallEndpoints(action.building.walls), floorBounds: getFloorBounds(action.building) } : null };
  if (action.type === 'clear-error') return { ...state, error: '' };
  if (action.type === 'undo') {
    if (!state.past.length || !state.present) return state;
    return { present: state.past[state.past.length - 1], past: state.past.slice(0, -1), future: [state.present, ...state.future], error: '' };
  }
  if (action.type === 'redo') {
    if (!state.future.length || !state.present) return state;
    return { present: state.future[0], past: [...state.past, state.present], future: state.future.slice(1), error: '' };
  }
  if (!state.present && action.command.type === 'import' && !action.command.append) return { ...initialEditor, present: action.command.building };
  if (!state.present) return state;
  const result = editBuilding(state.present, action.command);
  if (result.error || result.building === state.present) return { ...state, error: result.error ?? '' };
  return { present: result.building, past: [...state.past.slice(-49), state.present], future: [], error: '' };
}


export function floorRectangle(start: Point, end: Point): Point[] {
  return [{ x: Math.min(start.x, end.x), z: Math.min(start.z, end.z) }, { x: Math.max(start.x, end.x), z: Math.min(start.z, end.z) }, { x: Math.max(start.x, end.x), z: Math.max(start.z, end.z) }, { x: Math.min(start.x, end.x), z: Math.max(start.z, end.z) }];
}
