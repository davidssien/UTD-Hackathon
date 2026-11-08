/**
 * Placeables (final sprint): furniture and fixtures placed on a floor and rotated about the
 * vertical axis (D88). Furniture spans 0–0.5 m: people cannot walk through it, air passes over
 * it. An HVAC vent sits at the ceiling: people pass under it, and it supplies air.
 */
import type { Placeable, PlaceableItem, Vec2 } from './types.ts';

export interface PlaceableSpec {
  name: string;
  widthM: number;
  depthM: number;
  /** Height band above the floor (m); `null` top means up to the ceiling. */
  minZ: number;
  maxZ: number | null;
  blocksPeople: boolean;
  /** Supplies air to the floor (HVAC). */
  suppliesAir?: boolean;
}

export const PLACEABLES: Record<PlaceableItem, PlaceableSpec> = {
  table: { name: 'Table', widthM: 1.6, depthM: 0.8, minZ: 0, maxZ: 0.5, blocksPeople: true },
  desk: { name: 'Desk', widthM: 1.2, depthM: 0.6, minZ: 0, maxZ: 0.5, blocksPeople: true },
  chair: { name: 'Chair', widthM: 0.5, depthM: 0.5, minZ: 0, maxZ: 0.5, blocksPeople: true },
  counter: { name: 'Counter', widthM: 2.4, depthM: 0.6, minZ: 0, maxZ: 0.5, blocksPeople: true },
  vent: { name: 'HVAC vent', widthM: 0.6, depthM: 0.6, minZ: 2.4, maxZ: null, blocksPeople: false, suppliesAir: true },
};

/** Footprint corners (counter-clockwise) of a placeable, rotated about its centre. */
export function placeableFootprint(p: Pick<Placeable, 'item' | 'position' | 'rotationDeg'>): Vec2[] {
  const spec = PLACEABLES[p.item], a = (p.rotationDeg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a), hw = spec.widthM / 2, hd = spec.depthM / 2;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([x, y]) => ({ x: p.position.x + x * c - y * s, y: p.position.y + x * s + y * c }));
}
