import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ACTOR_EXITED, ACTOR_MOVING, openingSegment, parseDocument, type ActorFrame, type EgressDocument, type ScalarField, type Vec2 } from '@egress/core';
import { compileFloor } from '@egress/sim';
import { Playback } from '../src/playback.ts';

const doc: EgressDocument = parseDocument(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'content', 'scenes', 'hall.json'), 'utf8')));
const exits = doc.openings.filter(o => o.openingKind === 'exit');
const compiled = compileFloor(doc, doc.floors[0].id);

/** A walkable point about `metres` inside the building from an exit, and the door's centre. */
function nearExit(index: number, metres: number): { inside: Vec2; door: Vec2 } {
  const { a, b, normal } = openingSegment(doc, exits[index])!;
  const door = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  for (const sign of [1, -1]) {
    const inside = { x: door.x + normal.x * metres * sign, y: door.y + normal.y * metres * sign };
    const { origin, cellSizeM, width } = compiled.grid;
    const cell = Math.floor((inside.y - origin.y) / cellSizeM) * width + Math.floor((inside.x - origin.x) / cellSizeM);
    if (compiled.navigable[cell] && compiled.room[cell] >= 0) return { inside, door };
  }
  throw new Error('no walkable point near the exit');
}

/** Actor 0 waits by exit 0 and actor 1 by exit 1; both have left by the last frame. */
function playback(lastLeft = true) {
  const a = nearExit(0, 2), b = nearExit(1, 2);
  const frame = (tick: number, flag: number, p: Vec2, q: Vec2): ActorFrame => ({ tick, actorXY: Float32Array.of(p.x, p.y, q.x, q.y), actorFlags: Uint8Array.of(flag, lastLeft ? flag : ACTOR_MOVING) });
  const p = new Playback('run');
  p.setLayout(doc);
  p.pushFrames([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(t => frame(t, ACTOR_MOVING, a.inside, b.inside)));
  p.pushFrames([frame(10, ACTOR_EXITED, a.door, b.door)]);
  p.seek(10);
  return { p, a, b };
}

function heatNear(field: ScalarField, at: Vec2): number {
  const { origin, cellSizeM, width, height } = field.grid;
  let sum = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = field.values[y * width + x];
    if (Number.isFinite(v) && Math.hypot(origin.x + (x + 0.5) * cellSizeM - at.x, origin.y + (y + 0.5) * cellSizeM - at.y) < 3) sum += v;
  }
  return sum;
}

test('hovering an exit counts only the people who left through it', () => {
  const { p, a, b } = playback();
  const first = p.field('people.density', 'perCellPeak', undefined, exits[0].id)!;
  assert.ok(heatNear(first, a.inside) > 0);
  assert.equal(heatNear(first, b.inside), 0);
  const second = p.field('people.density', 'perCellPeak', undefined, exits[1].id)!;
  assert.equal(heatNear(second, a.inside), 0);
  assert.ok(heatNear(second, b.inside) > 0);
});

test('the unfiltered heatmap still counts everyone', () => {
  const { p, a, b } = playback();
  p.field('people.density', 'perCellPeak', undefined, exits[0].id);
  const all = p.field('people.density', 'perCellPeak')!;
  assert.ok(heatNear(all, a.inside) > 0 && heatNear(all, b.inside) > 0);
});

test('someone still inside is not counted for any exit yet', () => {
  const { p, b } = playback(false);
  assert.equal(heatNear(p.field('people.density', 'perCellPeak', undefined, exits[1].id)!, b.inside), 0);
});
