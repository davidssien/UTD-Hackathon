import test from 'node:test';
import assert from 'node:assert/strict';
import { structuralWalls, scanGaps, closeScanGap, refreshScanFloors } from '../lib/scan-structure.ts';
import { polygonArea } from '../lib/rooms.ts';
import type { Building, Wall } from '../lib/floorplan.ts';
const wall=(id:string,x1:number,z1:number,x2:number,z2:number,thickness=.2):Wall=>({id,x1,z1,x2,z2,thickness});
const shell=[wall('a',0,0,4,0),wall('b',5,0,8,0),wall('c',8,0,8,6),wall('d',8,6,0,6),wall('e',0,6,0,0)];
const building:Building={walls:shell,width:20,depth:20,sourceWidth:400,sourceHeight:400};
test('furniture outlines and thin annotations are excluded but recoverable',()=>{
 const furniture=[wall('chair1',2,2,3,2),wall('chair2',3,2,3,3),wall('chair3',3,3,2,3),wall('chair4',2,3,2,2),wall('text',4,4,5,4,.06)];
 const result=structuralWalls([...shell,...furniture]);
 assert.deepEqual(result.walls.map(w=>w.id).sort(),shell.map(w=>w.id).sort());assert.equal(result.ignored.length,5);
});
test('a blank gap is not silently classified, and manual opening restores entire room floor',()=>{
 const gaps=scanGaps(shell);assert.equal(gaps.length,1);assert.equal(gaps[0].evidence,undefined);
 assert.equal(refreshScanFloors(building).floors!.length,0);
 for(const kind of ['door','window','wall'] as const){const result=closeScanGap(building,gaps[0],kind);assert.equal(result.floors!.length,1);assert.equal(polygonArea(result.floors![0].points),48);assert.equal(result.walls.at(-1)!.openings!.length,kind==='wall'?0:1);assert.equal(scanGaps(result.walls).length,0);}
});
test('parallel glazing and perpendicular door leaves provide distinct opening evidence',()=>{
 const window=wall('glazing',4,0,5,0,.06),door=wall('leaf',4,0,4,1,.06);
 assert.equal(scanGaps(shell,[...shell,window])[0].evidence,'window');
 assert.equal(scanGaps(shell,[...shell,door])[0].evidence,'door');
 assert.equal(scanGaps(shell,[...shell,wall('unrelated',4,2,5,2,.06)])[0].evidence,undefined);
});
test('wide exterior separations are not bridged; manual floors survive rebuilding',()=>{
 assert.equal(scanGaps([wall('a',0,0,3,0),wall('b',8,0,12,0)]).length,0);
 const floor={id:'manual',kind:'drawn' as const,points:[{x:0,z:0},{x:1,z:0},{x:1,z:1}]};
 assert.deepEqual(refreshScanFloors({...building,floors:[floor]}).floors,[floor]);
});
test('slightly misaligned hosts are connected at actual endpoints without floor-breaking slivers',()=>{
 const walls=shell.map(w=>w.id==='b'?{...w,z1:.02}:w);
 const gap=scanGaps(walls)[0];assert.ok(gap);
 const result=closeScanGap({...building,walls},gap,'window');assert.equal(result.floors!.length,1);
});
