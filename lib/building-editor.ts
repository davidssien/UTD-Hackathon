import { polygonArea, roomAt } from './rooms.ts';
import { getFloorBounds } from './floorplan.ts';
import type { Building, Wall } from './floorplan';

export type Point = { x: number; z: number };
export type Tool = 'select' | 'wall' | 'floor' | 'fill-floor' | 'door' | 'window' | 'delete';
export type Opening = { id: string; type: 'door' | 'window'; offset: number; width: number; height: number; sill: number };
export type EditCommand =
  | { type: 'floor'; start: Point; end: Point }
  | { type: 'fill-floor'; point: Point }
  | { type: 'delete-floor'; floorId: string }
  | { type: 'wall'; start: Point; end: Point }
  | { type: 'opening'; wallId: string; kind: 'door' | 'window'; point: Point }
  | { type: 'delete-walls'; wallIds: string[] }
  | { type: 'delete'; wallId: string; openingId?: string };

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
  const floorBounds = getFloorBounds(building);
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
  if (action.type === 'load') return { ...initialEditor, present: action.building ? { ...action.building, floorBounds: getFloorBounds(action.building) } : null };
  if (action.type === 'clear-error') return { ...state, error: '' };
  if (action.type === 'undo') {
    if (!state.past.length || !state.present) return state;
    return { present: state.past[state.past.length - 1], past: state.past.slice(0, -1), future: [state.present, ...state.future], error: '' };
  }
  if (action.type === 'redo') {
    if (!state.future.length || !state.present) return state;
    return { present: state.future[0], past: [...state.past, state.present], future: state.future.slice(1), error: '' };
  }
  if (!state.present) return state;
  const result = editBuilding(state.present, action.command);
  if (result.error || result.building === state.present) return { ...state, error: result.error ?? '' };
  return { present: result.building, past: [...state.past.slice(-49), state.present], future: [], error: '' };
}


export function floorRectangle(start: Point, end: Point): Point[] {
  return [{ x: Math.min(start.x, end.x), z: Math.min(start.z, end.z) }, { x: Math.max(start.x, end.x), z: Math.min(start.z, end.z) }, { x: Math.max(start.x, end.x), z: Math.max(start.z, end.z) }, { x: Math.min(start.x, end.x), z: Math.max(start.z, end.z) }];
}
