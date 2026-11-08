import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from '@egress/core';
import { compileFloor } from '@egress/sim';
const doc = parseDocument(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'content', 'scenes', process.argv[2] ?? 'one-room.json'), 'utf8')));
const c = compileFloor(doc);
const { width, height } = c.grid;
let nav = 0, reach = 0, interior = 0;
for (let i = 0; i < width * height; i++) { if (c.navigable[i]) nav++; if (Number.isFinite(c.nav.fields[0][i])) reach++; if (c.room[i] >= 0) interior++; }
console.log({ width, height, origin: c.grid.origin, nav, reach, interior, exits: c.exits.map(e => ({ center: e.center, normal: e.normal, w: e.widthM })) });
const rows: string[] = [];
for (let cy = height - 1; cy >= 0; cy--) {
  let row = '';
  for (let cx = 0; cx < width; cx++) {
    const i = cy * width + cx;
    row += !c.navigable[i] ? (c.walkable[i] < 0.5 ? '#' : (c.room[i] >= 0 ? 'r' : ' ')) : Number.isFinite(c.nav.fields[0][i]) ? (c.nav.fields[0][i] === 0 ? 'S' : '.') : 'x';
  }
  rows.push(row);
}
console.log(rows.join('\n'));
