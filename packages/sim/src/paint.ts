/**
 * Population painting (Plan.md Pass 4.3, spec §4). Strokes change the
 * relative chance of starting in each cell; they never change the head count N.
 * Weights start at 1 on every spawnable cell and stay within [0, 4]; `erase`
 * restores 1. Strokes apply per cell, so a brush overlapping a wall produces
 * independent patches on each side and nothing is blurred through walls.
 */
import type { PopulationBrushStroke, Vec2 } from '@egress/core';
import type { CompiledFloor } from './compile.ts';

export const MAX_PAINT_WEIGHT = 4;

/** Cells people may spawn in: walkable interior cells. */
export const isSpawnable = (c: CompiledFloor, i: number) => c.navigable[i] === 1 && c.room[i] >= 0 && c.walkable[i] >= 0.5;

export function paintWeights(c: CompiledFloor, strokes: PopulationBrushStroke[]): Float32Array {
  const { width, height, origin, cellSizeM: cell } = c.grid;
  const w = new Float32Array(width * height);
  for (let i = 0; i < w.length; i++) if (isSpawnable(c, i)) w[i] = 1;
  for (const stroke of strokes) {
    if (stroke.floorId !== c.floorId || !stroke.points.length) continue;
    const xs = stroke.points.map(p => p.x), ys = stroke.points.map(p => p.y);
    const cx0 = Math.max(0, Math.floor((Math.min(...xs) - stroke.radiusM - origin.x) / cell));
    const cx1 = Math.min(width - 1, Math.floor((Math.max(...xs) + stroke.radiusM - origin.x) / cell));
    const cy0 = Math.max(0, Math.floor((Math.min(...ys) - stroke.radiusM - origin.y) / cell));
    const cy1 = Math.min(height - 1, Math.floor((Math.max(...ys) + stroke.radiusM - origin.y) / cell));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const i = cy * width + cx;
        if (!isSpawnable(c, i)) continue;
        const d = distanceToPolyline({ x: origin.x + (cx + 0.5) * cell, y: origin.y + (cy + 0.5) * cell }, stroke.points);
        if (d > stroke.radiusM) continue;
        const f = stroke.falloff === 'flat' ? 1 : Math.max(0, 1 - d / stroke.radiusM);
        const amount = Math.abs(stroke.weight);
        let next = w[i];
        if (stroke.mode === 'set') next = w[i] + (Math.min(MAX_PAINT_WEIGHT, Math.max(0, stroke.weight)) - w[i]) * f;
        else if (stroke.mode === 'increase') next = w[i] + amount * f;
        else if (stroke.mode === 'decrease') next = w[i] - amount * f;
        else next = w[i] + (1 - w[i]) * f; // erase restores the uniform weight
        w[i] = Math.min(MAX_PAINT_WEIGHT, Math.max(0, next));
      }
    }
  }
  return w;
}

function distanceToPolyline(p: Vec2, points: Vec2[]): number {
  if (points.length === 1) return Math.hypot(p.x - points[0].x, p.y - points[0].y);
  let best = Infinity;
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1], b = points[k];
    const abx = b.x - a.x, aby = b.y - a.y, len2 = abx * abx + aby * aby;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t)));
  }
  return best;
}
