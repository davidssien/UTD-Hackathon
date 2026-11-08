/**
 * Regenerates the scene fixtures from edit commands, so fixtures are always
 * valid EgressDocument v1 produced by the real applyEdit.
 *
 *   node content/scenes/generate.mts
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEditOrThrow, emptyDocument, type EditCommand, type EgressDocument, type Vec2 } from '@egress/core';

const here = dirname(fileURLToPath(import.meta.url));
const style = { thicknessM: 0.2, heightM: 2.8, material: 'normal' } as const;
const p = (x: number, y: number): Vec2 => ({ x, y });

function build(name: string, steps: ((doc: EgressDocument) => EditCommand[])[]): EgressDocument {
  let doc = emptyDocument(`fixture-${name}`, `${name}.floor0`);
  steps.forEach((step, i) => {
    doc = applyEditOrThrow(doc, { requestId: `${name}.s${i}`, commands: step(doc) }).doc;
  });
  return { ...doc, revision: 0 };
}

/** Wall whose endpoints are exactly a and b (in either direction). */
function wallBetween(doc: EgressDocument, a: Vec2, b: Vec2) {
  const at = (q: Vec2) => doc.vertices.find(v => Math.abs(v.position.x - q.x) < 1e-6 && Math.abs(v.position.y - q.y) < 1e-6)?.id;
  const va = at(a), vb = at(b);
  const wall = doc.walls.find(w => (w.startVertexId === va && w.endVertexId === vb) || (w.startVertexId === vb && w.endVertexId === va));
  if (!wall) throw new Error(`No wall between (${a.x},${a.y}) and (${b.x},${b.y})`);
  return { wall, fromStart: (q: Vec2) => Math.hypot(q.x - doc.vertices.find(v => v.id === wall.startVertexId)!.position.x, q.y - doc.vertices.find(v => v.id === wall.startVertexId)!.position.y) };
}

// 10 × 8 m room, one 0.9 m exit in the middle of the south wall.
const oneRoom = build('one-room', [
  doc => [{ kind: 'createWallChain', floorId: doc.floors[0].id, points: [p(0, 0), p(10, 0), p(10, 8), p(0, 8), p(0, 0)], ...style }],
  doc => {
    const south = wallBetween(doc, p(0, 0), p(10, 0));
    return [{ kind: 'createOpening', wallId: south.wall.id, openingKind: 'exit', offsetM: south.fromStart(p(5, 0)), widthM: 0.9 }];
  },
]);

// Two 8 × 10 m rooms north of a 2 m corridor (y 0–2). Each room has a 0.9 m door
// onto the corridor; the corridor's only exit is 1.2 m wide at its west end.
// Room B's occupants must pass Room A's door: a designed bottleneck.
const twoRooms = build('two-rooms-corridor', [
  doc => [{
    kind: 'createWallChain', floorId: doc.floors[0].id, ...style,
    points: [p(0, 0), p(16, 0), p(16, 2), p(16, 12), p(8, 12), p(0, 12), p(0, 2), p(0, 0)],
  }],
  doc => [
    { kind: 'createWallChain', floorId: doc.floors[0].id, points: [p(0, 2), p(8, 2), p(16, 2)], ...style },
    { kind: 'createWallChain', floorId: doc.floors[0].id, points: [p(8, 2), p(8, 12)], ...style },
  ],
  doc => {
    const exitWall = wallBetween(doc, p(0, 2), p(0, 0));
    const doorA = wallBetween(doc, p(0, 2), p(8, 2));
    const doorB = wallBetween(doc, p(8, 2), p(16, 2));
    return [
      { kind: 'createOpening', wallId: exitWall.wall.id, openingKind: 'exit', offsetM: exitWall.fromStart(p(0, 1)), widthM: 1.2 },
      { kind: 'createOpening', wallId: doorA.wall.id, openingKind: 'door', offsetM: doorA.fromStart(p(6, 2)), widthM: 0.9 },
      { kind: 'createOpening', wallId: doorB.wall.id, openingKind: 'door', offsetM: doorB.fromStart(p(10, 2)), widthM: 0.9 },
    ];
  },
]);

// 30 × 20 m hall split by a partition at x = 20 with one 1.6 m doorway. Main exit
// (2 m) on the west wall, a narrow 0.9 m exit on the east annex. Sized for 300–500 people.
const hall = build('hall', [
  doc => [{ kind: 'createBox', floorId: doc.floors[0].id, min: p(0, 0), max: p(30, 20), ...style }],
  doc => [{ kind: 'createWallChain', floorId: doc.floors[0].id, points: [p(20, 0), p(20, 20)], ...style }],
  doc => {
    const west = wallBetween(doc, p(0, 20), p(0, 0));
    const partitionLow = wallBetween(doc, p(20, 0), p(20, 20));
    const eastLow = wallBetween(doc, p(30, 0), p(30, 20));
    return [
      { kind: 'createOpening', wallId: west.wall.id, openingKind: 'exit', offsetM: west.fromStart(p(0, 10)), widthM: 2 },
      { kind: 'createOpening', wallId: partitionLow.wall.id, openingKind: 'door', offsetM: partitionLow.fromStart(p(20, 10)), widthM: 1.6 },
      { kind: 'createOpening', wallId: eastLow.wall.id, openingKind: 'exit', offsetM: eastLow.fromStart(p(30, 4)), widthM: 0.9 },
    ];
  },
]);

for (const [file, doc] of [['one-room.json', oneRoom], ['two-rooms-corridor.json', twoRooms], ['hall.json', hall]] as const) {
  writeFileSync(join(here, file), JSON.stringify(doc, null, 2) + '\n');
  console.log(`wrote ${file}: ${doc.walls.length} walls, ${doc.openings.length} openings`);
}
