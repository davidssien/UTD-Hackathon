/**
 * Example saves for demos (PLAN.md Pass 13): buildings of different sizes and layouts, built
 * from edit commands by the real applyEdit so every example is a valid EgressDocument.
 *
 *   node content/examples/generate.mts
 *
 * Writes one JSON per example and `index.json` (name, file, size note, suggested crowd).
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyEditOrThrow, emptyDocument, floorsByLevel, projectOnSegment, type EditCommand, type EgressDocument, type OpeningKind, type SlabMaterial,
  type Vec2, type WallMaterial,
} from '@egress/core';

const here = dirname(fileURLToPath(import.meta.url));
const p = (x: number, y: number): Vec2 => ({ x, y });
const wall = (material: WallMaterial = 'normal', thicknessM = 0.2) => ({ thicknessM, heightM: 2.8, material });

/** A step builds commands from the document so far; each step is one applyEdit batch. */
type Step = (doc: EgressDocument, floor: (level: number) => string) => EditCommand[];

function build(name: string, steps: Step[]): EgressDocument {
  let doc = emptyDocument(`example-${name}`, `${name}.floor0`);
  const floor = (level: number) => floorsByLevel(doc)[level].id;
  steps.forEach((step, i) => {
    doc = applyEditOrThrow(doc, { requestId: `${name}.s${i}`, commands: step(doc, floor) }).doc;
  });
  return { ...doc, revision: 0 };
}

/** An opening centred at `at`, on whichever wall piece of that floor passes through it. */
function opening(doc: EgressDocument, floorId: string, at: Vec2, openingKind: OpeningKind, widthM: number): EditCommand {
  const vs = new Map(doc.vertices.map(v => [v.id, v.position]));
  for (const w of doc.walls) {
    if (w.floorId !== floorId) continue;
    const a = vs.get(w.startVertexId)!, b = vs.get(w.endVertexId)!;
    const hit = projectOnSegment(at, a, b);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (hit.distance < 1e-6 && hit.t * len > widthM / 2 && (1 - hit.t) * len > widthM / 2) {
      return { kind: 'createOpening', wallId: w.id, openingKind, offsetM: hit.t * len, widthM };
    }
  }
  throw new Error(`No wall on ${floorId} fits a ${widthM} m ${openingKind} at (${at.x}, ${at.y})`);
}

const rect = (x0: number, y0: number, x1: number, y1: number) => [p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1)];
const slab = (floorId: string, x0: number, y0: number, x1: number, y1: number, material: SlabMaterial): EditCommand =>
  ({ kind: 'createSlab', floorId, polygon: rect(x0, y0, x1, y1), material });
const box = (floorId: string, x0: number, y0: number, x1: number, y1: number, material: WallMaterial = 'normal', t = 0.2): EditCommand =>
  ({ kind: 'createBox', floorId, min: p(x0, y0), max: p(x1, y1), ...wall(material, t) });
const line = (floorId: string, ...points: Vec2[]): EditCommand => ({ kind: 'createWallChain', floorId, points, ...wall() });

// ── Office floor (24 × 16 m): open plan, three offices, a meeting room, a corridor ──
const office = build('office', [
  (_d, f) => [box(f(0), 0, 0, 24, 16, 'reinforced', 0.3)],
  (_d, f) => [
    line(f(0), p(0, 7), p(24, 7)), line(f(0), p(0, 9.5), p(24, 9.5)),
    line(f(0), p(5, 9.5), p(5, 16)), line(f(0), p(10, 9.5), p(10, 16)), line(f(0), p(15, 9.5), p(15, 16)),
    line(f(0), p(16, 0), p(16, 7)), line(f(0), p(20, 0), p(20, 7)),
  ],
  (d, f) => [
    opening(d, f(0), p(2.5, 9.5), 'door', 0.9), opening(d, f(0), p(7.5, 9.5), 'door', 0.9), opening(d, f(0), p(12.5, 9.5), 'door', 0.9),
    opening(d, f(0), p(19.5, 9.5), 'door', 1.6),
    opening(d, f(0), p(4, 7), 'door', 1.2), opening(d, f(0), p(12, 7), 'door', 1.2), opening(d, f(0), p(18, 7), 'door', 0.9), opening(d, f(0), p(22, 7), 'door', 0.9),
    opening(d, f(0), p(0, 8.25), 'exit', 1.6), opening(d, f(0), p(24, 8.25), 'exit', 1.2), opening(d, f(0), p(8, 0), 'exit', 1.2),
    opening(d, f(0), p(2.5, 16), 'window', 1.5), opening(d, f(0), p(7.5, 16), 'window', 1.5), opening(d, f(0), p(12.5, 16), 'window', 1.5),
    opening(d, f(0), p(19.5, 16), 'window', 2.4), opening(d, f(0), p(3, 0), 'window', 1.8), opening(d, f(0), p(13, 0), 'window', 1.8),
  ],
  (_d, f) => [
    slab(f(0), 0, 9.5, 5, 16, 'wood'), slab(f(0), 5, 9.5, 10, 16, 'wood'), slab(f(0), 10, 9.5, 15, 16, 'wood'), slab(f(0), 15, 9.5, 24, 16, 'wood'),
    slab(f(0), 0, 7, 24, 9.5, 'tile'), slab(f(0), 0, 0, 16, 7, 'wood'), slab(f(0), 16, 0, 20, 7, 'tile'), slab(f(0), 20, 0, 24, 7, 'basic'),
  ],
]);

// ── School wing (48 × 20 m): a 3 m corridor with eleven classrooms and an entry lobby ──
const school = build('school', [
  (_d, f) => [box(f(0), 0, 0, 48, 20, 'reinforced', 0.3)],
  (_d, f) => [
    line(f(0), p(0, 8.5), p(48, 8.5)), line(f(0), p(0, 11.5), p(48, 11.5)),
    ...[8, 16, 24, 32, 40].map(x => line(f(0), p(x, 11.5), p(x, 20))),
    ...[10, 20, 28, 38].map(x => line(f(0), p(x, 0), p(x, 8.5))),
  ],
  (d, f) => [
    ...[4, 12, 20, 28, 36, 44].map(x => opening(d, f(0), p(x, 11.5), 'door', 1)),
    ...[5, 15, 33, 43].map(x => opening(d, f(0), p(x, 8.5), 'door', 1)),
    opening(d, f(0), p(24, 8.5), 'door', 3),
    opening(d, f(0), p(0, 10), 'exit', 1.8), opening(d, f(0), p(48, 10), 'exit', 1.8), opening(d, f(0), p(24, 0), 'exit', 2.4),
    ...[4, 12, 20, 28, 36, 44].map(x => opening(d, f(0), p(x, 20), 'window', 3)),
    ...[5, 15, 33, 43].map(x => opening(d, f(0), p(x, 0), 'window', 3)),
  ],
  (_d, f) => [
    slab(f(0), 0, 8.5, 48, 11.5, 'tile'), slab(f(0), 20, 0, 28, 8.5, 'tile'),
    ...[0, 8, 16, 24, 32, 40].map(x => slab(f(0), x, 11.5, x + 8, 20, 'wood')),
    ...[[0, 10], [10, 20], [28, 38], [38, 48]].map(([a, b]) => slab(f(0), a, 0, b, 8.5, 'wood')),
  ],
]);

// ── Event hall (36 × 24 m): foyer, main hall, backstage; sized for a big crowd ──
const eventHall = build('event-hall', [
  (_d, f) => [box(f(0), 0, 0, 36, 24, 'reinforced', 0.3)],
  (_d, f) => [
    line(f(0), p(8, 0), p(8, 24)),
    line(f(0), p(0, 5), p(8, 5)), line(f(0), p(0, 19), p(8, 19)),
    line(f(0), p(36, 6), p(31, 6), p(31, 18), p(36, 18)),
  ],
  (d, f) => [
    opening(d, f(0), p(8, 8.5), 'door', 2.4), opening(d, f(0), p(8, 15.5), 'door', 2.4),
    opening(d, f(0), p(4, 5), 'door', 1), opening(d, f(0), p(4, 19), 'door', 1), opening(d, f(0), p(31, 12), 'door', 1.2),
    opening(d, f(0), p(0, 12), 'exit', 3), opening(d, f(0), p(20, 24), 'exit', 1.8), opening(d, f(0), p(20, 0), 'exit', 1.8), opening(d, f(0), p(36, 12), 'exit', 1),
    opening(d, f(0), p(14, 24), 'window', 3), opening(d, f(0), p(26, 24), 'window', 3), opening(d, f(0), p(14, 0), 'window', 3), opening(d, f(0), p(26, 0), 'window', 3),
  ],
  (_d, f) => [slab(f(0), 8, 0, 36, 24, 'wood'), slab(f(0), 0, 5, 8, 19, 'tile'), slab(f(0), 0, 0, 8, 5, 'basic'), slab(f(0), 0, 19, 8, 24, 'tile'), slab(f(0), 31, 6, 36, 18, 'basic')],
]);

// ── Two-storey clinic (20 × 15 m per floor): lobby, exam rooms, pharmacy; offices upstairs, joined by a stair ──
const clinic = build('clinic', [
  (_d, f) => [box(f(0), 0, 0, 20, 15, 'normal', 0.25)],
  (_d, f) => [
    line(f(0), p(0, 8), p(20, 8)), line(f(0), p(0, 10), p(20, 10)),
    line(f(0), p(5, 10), p(5, 15)), line(f(0), p(10, 10), p(10, 15)), line(f(0), p(14, 10), p(14, 15)),
    line(f(0), p(12, 0), p(12, 8)),
  ],
  (d, f) => [
    opening(d, f(0), p(2.5, 10), 'door', 0.9), opening(d, f(0), p(7.5, 10), 'door', 0.9), opening(d, f(0), p(12, 10), 'door', 0.9), opening(d, f(0), p(17, 10), 'door', 1.2),
    opening(d, f(0), p(6, 8), 'door', 2.4), opening(d, f(0), p(16, 8), 'door', 1), opening(d, f(0), p(12, 4), 'door', 1),
    opening(d, f(0), p(6, 0), 'exit', 2), opening(d, f(0), p(0, 9), 'exit', 1.2), opening(d, f(0), p(20, 4), 'exit', 1.2),
    opening(d, f(0), p(2.5, 15), 'window', 1.5), opening(d, f(0), p(7.5, 15), 'window', 1.5), opening(d, f(0), p(12, 15), 'window', 1.5), opening(d, f(0), p(16, 0), 'window', 2),
  ],
  () => [{ kind: 'createFloor', name: 'First floor', ceilingHeightM: 3.2 }],
  (_d, f) => [
    box(f(1), 0, 0, 20, 15, 'normal', 0.25),
    { kind: 'createStair', floorId: f(0), min: p(15.5, 10.3), max: p(17, 14.7), upEdge: 'n' },
  ],
  (_d, f) => [
    line(f(1), p(0, 8), p(20, 8)), line(f(1), p(0, 10), p(20, 10)),
    line(f(1), p(5, 10), p(5, 15)), line(f(1), p(10, 10), p(10, 15)), line(f(1), p(14, 10), p(14, 15)),
    line(f(1), p(7, 0), p(7, 8)), line(f(1), p(14, 0), p(14, 8)),
  ],
  (d, f) => [
    opening(d, f(1), p(2.5, 10), 'door', 0.9), opening(d, f(1), p(7.5, 10), 'door', 0.9), opening(d, f(1), p(12, 10), 'door', 0.9), opening(d, f(1), p(17, 10), 'door', 1.2),
    opening(d, f(1), p(3.5, 8), 'door', 0.9), opening(d, f(1), p(10.5, 8), 'door', 0.9), opening(d, f(1), p(17, 8), 'door', 0.9),
    opening(d, f(1), p(3.5, 0), 'window', 2), opening(d, f(1), p(10.5, 0), 'window', 2), opening(d, f(1), p(17, 0), 'window', 2),
    opening(d, f(1), p(2.5, 15), 'window', 1.5), opening(d, f(1), p(7.5, 15), 'window', 1.5), opening(d, f(1), p(12, 15), 'window', 1.5),
  ],
  (_d, f) => [
    slab(f(0), 0, 0, 12, 8, 'tile'), slab(f(0), 12, 0, 20, 8, 'basic'), slab(f(0), 0, 8, 20, 10, 'tile'),
    slab(f(0), 0, 10, 5, 15, 'basic'), slab(f(0), 5, 10, 10, 15, 'basic'), slab(f(0), 10, 10, 14, 15, 'basic'),
    slab(f(1), 0, 0, 7, 8, 'wood'), slab(f(1), 7, 0, 14, 8, 'wood'), slab(f(1), 14, 0, 20, 8, 'wood'), slab(f(1), 0, 8, 20, 10, 'tile'),
    slab(f(1), 0, 10, 5, 15, 'wood'), slab(f(1), 5, 10, 10, 15, 'wood'), slab(f(1), 10, 10, 14, 15, 'wood'), slab(f(1), 14, 10, 20, 15, 'tile'),
  ],
]);

export const EXAMPLES = [
  { id: 'office', name: 'Office floor', note: '24 × 16 m · offices, meeting room, open plan', people: 120, doc: office },
  { id: 'school', name: 'School wing', note: '48 × 20 m · eleven classrooms off one corridor', people: 320, doc: school },
  { id: 'event-hall', name: 'Event hall', note: '36 × 24 m · foyer, hall and backstage', people: 500, doc: eventHall },
  { id: 'clinic', name: 'Two-storey clinic', note: '20 × 15 m · two floors joined by a stair', people: 80, doc: clinic },
];

const index = EXAMPLES.map(({ id, name, note, people }) => ({ id, name, note, people, file: `${id}.json` }));
for (const e of EXAMPLES) {
  writeFileSync(join(here, `${e.id}.json`), JSON.stringify(e.doc, null, 2) + '\n');
  console.log(`wrote ${e.id}.json: ${e.doc.floors.length} floor(s), ${e.doc.walls.length} walls, ${e.doc.openings.length} openings, ${e.doc.slabs.length} surfaces, ${e.doc.stairs.length} stair(s)`);
}
writeFileSync(join(here, 'index.json'), JSON.stringify(index, null, 2) + '\n');
