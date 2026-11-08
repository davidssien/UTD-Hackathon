/**
 * Turns a reviewed sketch import (the legacy `Building` from the importer) into
 * a canonical EgressDocument, using the same edit commands the editor uses, so
 * T-junctions split and corners join exactly as if the walls were drawn.
 * Legacy plans use z pointing down; canonical plans use +y = north.
 */
import { applyEdit, emptyDocument, projectOnSegment, type EgressDocument, type Vec2 } from '@egress/core';
import type { Building } from './floorplan';

const snap = (v: number) => Math.round(v * 4) / 4;

export function buildingToDocument(building: Building, projectId = 'import'): EgressDocument {
  let doc = emptyDocument(projectId);
  const floorId = doc.floors[0].id;
  let n = 0;
  const toPlan = (x: number, z: number): Vec2 => ({ x: snap(x), y: snap(-z) });
  for (const w of building.walls) {
    const a = toPlan(w.x1, w.z1), b = toPlan(w.x2, w.z2);
    if (Math.hypot(b.x - a.x, b.y - a.y) < 0.25) continue;
    const result = applyEdit(doc, {
      requestId: `import${n++}`,
      commands: [{ kind: 'createWallChain', floorId, points: [a, b], thicknessM: Math.min(0.5, Math.max(0.08, w.thickness)), heightM: 2.8, material: 'normal' }],
    });
    if (result.ok) doc = result.doc;
  }
  for (const w of building.walls) {
    const length = Math.hypot(w.x2 - w.x1, w.z2 - w.z1);
    if (length < 0.01) continue;
    for (const o of w.openings ?? []) {
      const t = Math.min(1, Math.max(0, o.offset / length));
      const center = { x: w.x1 + (w.x2 - w.x1) * t, y: -(w.z1 + (w.z2 - w.z1) * t) };
      const vertices = new Map(doc.vertices.map(v => [v.id, v.position]));
      let best: { wallId: string; offset: number; distance: number; length: number } | null = null;
      for (const wall of doc.walls) {
        const a = vertices.get(wall.startVertexId)!, b = vertices.get(wall.endVertexId)!;
        const hit = projectOnSegment(center, a, b), len = Math.hypot(b.x - a.x, b.y - a.y);
        if (!best || hit.distance < best.distance) best = { wallId: wall.id, offset: hit.t * len, distance: hit.distance, length: len };
      }
      if (!best || best.distance > 0.5) continue;
      const width = Math.min(o.width, best.length - 0.1);
      if (width < 0.5) continue;
      const result = applyEdit(doc, {
        requestId: `import${n++}`,
        commands: [{ kind: 'createOpening', wallId: best.wallId, openingKind: o.type, offsetM: Math.min(best.length - width / 2, Math.max(width / 2, best.offset)), widthM: width }],
      });
      if (result.ok) doc = result.doc;
    }
  }
  return doc;
}
