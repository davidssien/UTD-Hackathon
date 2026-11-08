/**
 * Simple procedural models for placeables, built from boxes. Local axes: x across the item's width,
 * y up from the floor, z across its depth with +z the item's back side in plan (−y in plan at 0°).
 * Every part stays inside the footprint and the height band the simulation uses: furniture below
 * 0.5 m (people walk around it, air passes over), vents at the ceiling. Pure, so it can be tested.
 */
import { PLACEABLES, type PlaceableItem } from '@egress/core';

export type PartTone = 'top' | 'frame' | 'seat' | 'body' | 'grille';
export interface ModelPart { size: [number, number, number]; at: [number, number, number]; tone: PartTone }

const box = (w: number, h: number, d: number, x: number, y: number, z: number, tone: PartTone): ModelPart => ({ size: [w, h, d], at: [x, y + h / 2, z], tone });

/** Four square legs inset from the corners, from the floor to `height`. */
function legs(w: number, d: number, height: number, inset: number, size: number, tone: PartTone): ModelPart[] {
  const x = w / 2 - inset - size / 2, z = d / 2 - inset - size / 2;
  return [[-x, -z], [x, -z], [-x, z], [x, z]].map(([lx, lz]) => box(size, height, size, lx, 0, lz, tone));
}

export function placeableModel(item: PlaceableItem, ceilingM: number): ModelPart[] {
  const { widthM: w, depthM: d } = PLACEABLES[item];
  switch (item) {
    case 'table': // a 4 cm top on four legs
      return [box(w, 0.04, d, 0, 0.46, 0, 'top'), ...legs(w, d, 0.46, 0.05, 0.05, 'frame')];
    case 'desk': // a top on two side panels, with a modesty panel at the far side from the chair
      return [
        box(w, 0.035, d, 0, 0.465, 0, 'top'),
        box(0.03, 0.465, d - 0.04, -(w / 2 - 0.03), 0, 0, 'frame'), box(0.03, 0.465, d - 0.04, w / 2 - 0.03, 0, 0, 'frame'),
        box(w - 0.1, 0.24, 0.02, 0, 0.2, -(d / 2 - 0.04), 'frame'),
      ];
    case 'chair': { // a seat on four legs, the backrest behind the sitter (+z)
      const seat = 0.28;
      return [
        box(w - 0.06, 0.04, d - 0.08, 0, seat, 0.02, 'seat'),
        ...legs(w - 0.06, d - 0.08, seat, 0.03, 0.03, 'frame').map(p => ({ ...p, at: [p.at[0], p.at[1], p.at[2] + 0.02] as [number, number, number] })),
        box(w - 0.06, 0.18, 0.04, 0, seat + 0.04, d / 2 - 0.04, 'seat'),
      ];
    }
    case 'counter': // a solid base slightly inset, under an overhanging top
      return [box(w - 0.04, 0.46, d - 0.1, 0, 0, 0.03, 'body'), box(w, 0.04, d, 0, 0.46, 0, 'top')];
    case 'vent': { // a square grille in the ceiling: frame and slats
      const y = ceilingM - 0.06, t = 0.04, slats = 5;
      return [
        box(w, t, 0.05, 0, y, -(d / 2 - 0.025), 'frame'), box(w, t, 0.05, 0, y, d / 2 - 0.025, 'frame'),
        box(0.05, t, d - 0.1, -(w / 2 - 0.025), y, 0, 'frame'), box(0.05, t, d - 0.1, w / 2 - 0.025, y, 0, 'frame'),
        ...Array.from({ length: slats }, (_, i) => box(w - 0.1, 0.02, 0.035, 0, y + 0.01, -d / 2 + 0.05 + (i + 0.5) * (d - 0.1) / slats, 'grille')),
      ];
    }
  }
}
