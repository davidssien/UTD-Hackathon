import test from 'node:test';
import assert from 'node:assert/strict';
import { rotateScan, detectOrientedWalls } from '../lib/scan-orientation.ts';
function plan(){
  const width=240,height=180,data=new Uint8ClampedArray(width*height*4).fill(255);
  for(let y=25;y<155;y++)for(let x=25;x<215;x++)if(x<30||x>=210||y<30||y>=150){const i=(y*width+x)*4;data[i]=data[i+1]=data[i+2]=0;}
  return {width,height,data} as ImageData;
}
test('rotated plans retain four measured walls in source-image coordinates',()=>{
  const input=rotateScan(plan(),20*Math.PI/180);
  const result=detectOrientedWalls(input);
  assert.ok(Math.abs(result.rotation+20)<=1);
  assert.equal(result.building.walls.length,4);
  assert.equal(result.building.sourceWidth,input.width);
  assert.ok(result.building.walls.every(w=>Math.abs(w.x2-w.x1)>.1&&Math.abs(w.z2-w.z1)>.1));
});
test('blank scans remain empty and unrotated',()=>{
  const input=plan();input.data.fill(255);
  const result=detectOrientedWalls(input);assert.equal(result.rotation,0);assert.equal(result.building.walls.length,0);
});
