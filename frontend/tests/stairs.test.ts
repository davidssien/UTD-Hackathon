import assert from 'node:assert/strict';
import { test } from 'node:test';
import { floorSurface, stairSteps, upEdgeOf } from '../lib/stairs.ts';

test('upEdgeOf follows the drag along the longer side', () => {
  assert.equal(upEdgeOf({ x: 0, y: 0 }, { x: 1, y: 4 }), 'n');
  assert.equal(upEdgeOf({ x: 0, y: 4 }, { x: 1, y: 0 }), 's');
  assert.equal(upEdgeOf({ x: 0, y: 0 }, { x: 5, y: 1 }), 'e');
  assert.equal(upEdgeOf({ x: 5, y: 0 }, { x: 0, y: 1 }), 'w');
});

test('stairSteps climbs toward the up edge and reaches the floor above', () => {
  const stair = { min: { x: 0, y: 0 }, max: { x: 1.2, y: 4 }, upEdge: 'n' as const };
  const steps = stairSteps(stair, 3);
  assert.ok(steps.at(-1)!.max.y - steps.at(-1)!.min.y >= 0.6, 'the landing fits a discrete person');
  assert.equal(steps.length, 17, '3 m at about 18 cm risers');
  assert.equal(steps[0].min.y, 0, 'the bottom step is at the far side from the up edge');
  assert.ok(Math.abs(steps.at(-1)!.max.y - 4) < 1e-9);
  assert.ok(Math.abs(steps.at(-1)!.top - 3) < 1e-9);
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i].top > steps[i - 1].top);
  const south = stairSteps({ ...stair, upEdge: 's' }, 3);
  assert.ok(Math.abs(south[0].max.y - 4) < 1e-9, 'a south stair starts at the north side');
  const west = stairSteps({ min: { x: 0, y: 0 }, max: { x: 4, y: 1.2 }, upEdge: 'w' }, 0.3);
  assert.equal(west.length, 3, 'at least three steps');
  assert.ok(Math.abs(west.at(-1)!.min.x) < 1e-9);
});

test('a shaft cuts across adjoining slabs and overlapping shafts are only cut once', () => {
  const shaft = { min: { x: 1, y: 1 }, max: { x: 3, y: 3 } };
  for (const start of [0, 2]) {
    const surface = floorSurface([{ x: start, y: 0 }, { x: start + 2, y: 0 }, { x: start + 2, y: 4 }, { x: start, y: 4 }], [shaft, shaft]);
    const pos = surface.getAttribute('position');
    let area = 0;
    for (let i = 0; i < pos.count; i += 3) {
      const x = pos.getX(i), y = pos.getY(i);
      area += ((pos.getX(i + 1) - x) * (pos.getY(i + 2) - y) - (pos.getY(i + 1) - y) * (pos.getX(i + 2) - x)) / 2;
    }
    assert.ok(Math.abs(area - 6) < 1e-6);
    surface.dispose();
  }
});
