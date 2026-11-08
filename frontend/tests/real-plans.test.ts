import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import {recognizeSketch} from '../lib/sketch-import.ts';
import {polygonArea} from '../lib/rooms.ts';
import {rectangularFootprint} from '../lib/scan-structure.ts';
test('actual A1.2 construction plan produces a floor covering the house, not just the WC',async()=>{
 const {data,info}=await sharp(fileURLToPath(new URL('./fixtures/real-plans/farmhouse-first-floor.png', import.meta.url))).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 const result=recognizeSketch({data,width:info.width,height:info.height} as unknown as ImageData);
 const floor=result.building.floors?.find(f=>f.id==='detected-footprint');assert.ok(floor);
 // Manually inspected drawing: exterior occupies almost the full 870x443 crop.
 // Reject the previous tiny-room-only result and oversized image-based slabs.
 assert.ok(polygonArea(floor.points)>180&&polygonArea(floor.points)<205);
 assert.ok(result.building.walls.length<60);
});
test('an open or L-shaped perimeter does not invent a rectangular floor',()=>{
 const wall=(id:string,x1:number,z1:number,x2:number,z2:number)=>({id,x1,z1,x2,z2,thickness:.2});
 assert.equal(rectangularFootprint([wall('a',0,0,8,0),wall('b',8,0,8,3),wall('c',8,3,4,3),wall('d',4,3,4,6),wall('e',4,6,0,6),wall('f',0,6,0,0)]),null);
});
