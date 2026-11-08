import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PLACEABLES, type PlaceableItem } from '@egress/core';
import { placeableModel } from '../lib/placeable-models.ts';

test('every model stays inside its simulated footprint and height band', () => {
  for (const item of Object.keys(PLACEABLES) as PlaceableItem[]) {
    const spec = PLACEABLES[item], parts = placeableModel(item, 3);
    assert.ok(parts.length >= 2, `${item} is built from parts`);
    for (const { size: [w, h, d], at: [x, y, z] } of parts) {
      assert.ok(Math.abs(x) + w / 2 <= spec.widthM / 2 + 1e-9 && Math.abs(z) + d / 2 <= spec.depthM / 2 + 1e-9, `${item} part inside the footprint`);
      const low = y - h / 2, high = y + h / 2;
      if (spec.suppliesAir) assert.ok(low >= spec.minZ && high <= 3, `${item} at the ceiling`);
      else assert.ok(low >= -1e-9 && high <= 0.5 + 1e-9, `${item} part below 0.5 m (${high.toFixed(3)})`);
    }
  }
});

test('a chair faces away from its backrest: the back is on its +z side', () => {
  const back = placeableModel('chair', 3).reduce((a, b) => (b.at[1] > a.at[1] ? b : a));
  assert.ok(back.at[2] > 0.15, 'the highest part (the backrest) sits at the back');
});
