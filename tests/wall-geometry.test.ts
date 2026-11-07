import test from 'node:test';
import assert from 'node:assert/strict';
import { wallGeometries } from '../lib/wall-geometry.ts';
import { editBuilding } from '../lib/building-editor.ts';
import type { Wall } from '../lib/floorplan';

function area(walls: Wall[]) {
  let total = 0;
  for (const geometry of wallGeometries(walls).values()) {
    const p = geometry.getAttribute('position');
    for (let i = 0; i < p.count; i += 3) {
      const ax=p.getX(i+1)-p.getX(i), ay=p.getY(i+1)-p.getY(i), az=p.getZ(i+1)-p.getZ(i);
      const bx=p.getX(i+2)-p.getX(i), by=p.getY(i+2)-p.getY(i), bz=p.getZ(i+2)-p.getZ(i);
      total += Math.hypot(ay*bz-az*by, az*bx-ax*bz, ax*by-ay*bx)/2;
    }
    geometry.dispose();
  }
  return total;
}
const horizontal: Wall = { id:'a',x1:-2,z1:0,x2:2,z2:0,thickness:.2 };
test('crossing walls have only the union exterior, with no doubled top surfaces', () => {
  assert.ok(Math.abs(area([horizontal, {id:'b',x1:0,z1:-2,x2:0,z2:2,thickness:.2}])-47.92)<.0001);
});
test('adjacent collinear walls remove their shared end caps', () => {
  assert.ok(Math.abs(area([{...horizontal,x2:0},{...horizontal,id:'b',x1:0}])-area([horizontal]))<.0001);
});
test('new connected walls inherit the existing wall thickness', () => {
  const result=editBuilding({ walls:[{...horizontal,thickness:.32}],width:4,depth:4,sourceWidth:100,sourceHeight:100 },{type:'wall',start:{x:2,z:0},end:{x:2,z:3}});
  assert.equal(result.building.walls[1].thickness,.32);
});

test('right-angle corners share mitered edges without square-cap steps', () => {
  const a = { ...horizontal, x1: 0, x2: 4 };
  const b = { ...horizontal, id: 'b', x1: 4, x2: 4, z2: 4 };
  const geometries = wallGeometries([a,b]);
  const positions = geometries.get('a')!.getAttribute('position');
  const corner = Array.from({length: positions.count}, (_, i) => [positions.getX(i),positions.getZ(i)]);
  assert.ok(corner.some(([x,z]) => Math.abs(x-4.1)<1e-5 && Math.abs(z+.1)<1e-5));
  assert.ok(corner.some(([x,z]) => Math.abs(x-3.9)<1e-5 && Math.abs(z-.1)<1e-5));
  assert.ok(Math.abs(area([a,b])-49.12)<.0001);
  geometries.forEach(g => g.dispose());
});
