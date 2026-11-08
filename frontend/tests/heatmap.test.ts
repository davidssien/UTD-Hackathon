import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScalarField } from '@egress/core';
import { encodeField, fieldScale } from '../lib/heatmap.ts';

const field = (values: number[]): ScalarField => ({
  fieldId: 'people.density', aggregation: 'instant', units: 'p/m²', values: new Float32Array(values),
  grid: { floorId: 'f', origin: { x: 0, y: 0 }, cellSizeM: 0.25, width: values.length, height: 1 },
});

test('encodeField keeps values and marks walls (NaN) as not walkable', () => {
  const data = encodeField(field([0.5, Number.NaN, 2]));
  assert.deepEqual([...data], [0.5, 1, 0, 0, 2, 1]);
});

test('fieldScale is fixed for heat and symmetric for difference maps', () => {
  assert.equal(fieldScale(field([0.5, 9]), false, 3.5), 3.5);
  assert.equal(fieldScale(field([0.5, -2, Number.NaN, 1]), true, 3.5), 2);
  assert.ok(fieldScale(field([Number.NaN]), true, 3.5) > 0, 'never zero');
});
