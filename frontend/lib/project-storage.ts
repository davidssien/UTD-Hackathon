import type { Building } from './floorplan';

export const PROJECT_KEY = 'exitcraft-project-v1';

export function decodeProject(raw: string): { source: string; building: Building } {
  const p = JSON.parse(raw);
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  const positive = (n: unknown) => finite(n) && (n as number) > 0;
  const point = (v: any) => v && finite(v.x) && finite(v.z);
  const b = p?.building;
  if (p?.version !== 1 || typeof p.source !== 'string' ||
      !(p.source === '/sample-plan.svg' || /^data:image\/(png|jpeg|webp);base64,/.test(p.source)) ||
      !b || (b.references !== undefined && (!Array.isArray(b.references) || b.references.length > 100 || !b.references.every((r: any) => r && typeof r.image === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(r.image) && [r.width,r.depth].every(positive) && [r.x,r.z,r.rotation].every(finite)))) || (b.referenceImage !== undefined && (typeof b.referenceImage !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(b.referenceImage))) || ![b.width, b.depth, b.sourceWidth, b.sourceHeight].every(positive) ||
      !Array.isArray(b.walls) || b.walls.length > 10000 ||
      !b.walls.every((w: any) => w && typeof w.id === 'string' &&
        [w.x1, w.x2, w.z1, w.z2].every(finite) && positive(w.thickness) &&
        (w.openings === undefined || Array.isArray(w.openings) && w.openings.every((o: any) =>
          o && typeof o.id === 'string' && ['door', 'window'].includes(o.type) &&
          finite(o.offset) && positive(o.width) && positive(o.height) && finite(o.sill)))) ||
      (b.floors !== undefined && (!Array.isArray(b.floors) || !b.floors.every((f: any) =>
        f && typeof f.id === 'string' && ['drawn', 'room'].includes(f.kind) &&
        Array.isArray(f.points) && f.points.length >= 3 && f.points.every(point)))) ||
      (b.floorBounds != null && !['minX', 'maxX', 'minZ', 'maxZ'].every(k => finite(b.floorBounds[k])))) {
    throw new Error('Invalid saved project');
  }
  return { source: p.source, building: b };
}
