import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectWalls, getWallBounds } from '../lib/floorplan.ts';

function drawing(width = 200, height = 150) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  return {
    image: { data, width, height } as ImageData,
    rect(x: number, y: number, w: number, h: number, value = 20) {
      for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
        const i = (row * width + col) * 4;
        data[i] = data[i + 1] = data[i + 2] = value;
      }
    },
  };
}

test('extracts wall centerlines and thickness with calibrated real-world dimensions', () => {
  const d = drawing(); d.rect(20, 20, 160, 6); d.rect(20, 20, 6, 110);
  const b = detectWalls(d.image, 20, 115, 5);
  assert.equal(b.width, 20); assert.equal(b.depth, 15); assert.equal(b.walls.length, 2);
  assert.ok(b.walls.every(w => Math.abs(w.thickness - .6) < .001));
  assert.ok(b.walls.some(w => w.z1 === w.z2 && Math.abs(w.x1 + 8) < .001));
  assert.ok(b.walls.some(w => w.x1 === w.x2));
});

test('preserves door openings while bridging small scan artifacts', () => {
  const d = drawing(); d.rect(10, 40, 70, 6); d.rect(100, 40, 80, 6);
  d.rect(45, 40, 2, 6, 255);
  const b = detectWalls(d.image, 20, 115, 5);
  assert.equal(b.walls.length, 2);
  const horizontal = b.walls.sort((a,b) => a.x1-b.x1);
  assert.ok(Math.abs(horizontal[1].x1 - horizontal[0].x2 - 2) < .001);
});

test('rejects blank images, short labels, thin annotations, and broad filled regions', () => {
  const d = drawing(); assert.equal(detectWalls(d.image, 20, 115, 5).walls.length, 0);
  d.rect(10, 10, 5, 3); d.rect(20, 30, 80, 1); d.rect(30, 60, 70, 40);
  assert.equal(detectWalls(d.image, 20, 115, 5).walls.length, 0);
});

test('threshold adjustment changes recognition without accepting transparent black pixels', () => {
  const d = drawing(); d.rect(20, 30, 140, 5, 150);
  assert.equal(detectWalls(d.image, 20, 115, 5).walls.length, 0);
  assert.equal(detectWalls(d.image, 20, 180, 5).walls.length, 1);
  d.image.data.fill(0);
  assert.equal(detectWalls(d.image, 20, 180, 5).walls.length, 0);
});


test('floor bounds follow offset wall geometry instead of image margins', () => {
  const walls = [
    { id: 'north', x1: 3, z1: 2, x2: 11, z2: 2, thickness: .2 },
    { id: 'south', x1: 3, z1: 8, x2: 11, z2: 8, thickness: .2 },
    { id: 'west', x1: 3, z1: 2, x2: 3, z2: 8, thickness: .2 },
    { id: 'east', x1: 11, z1: 2, x2: 11, z2: 8, thickness: .2 },
  ];
  const bounds = getWallBounds(walls)!;
  assert.deepEqual(bounds, { minX: 2.9, maxX: 11.1, minZ: 1.9, maxZ: 8.1 });
  assert.equal((bounds.minX + bounds.maxX) / 2, 7);
  assert.equal((bounds.minZ + bounds.maxZ) / 2, 5);
});

test('floor bounds handle empty and degenerate geometry', () => {
  assert.equal(getWallBounds([]), null);
  assert.equal(getWallBounds([{ id: 'zero', x1: 0, z1: 0, x2: 0, z2: 0, thickness: .2 }]), null);
});
