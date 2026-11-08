import type { Wall } from './floorplan.ts';
// Architectural walls are often two thin outlines with white space between.
// Pair only neighboring parallel edges with substantial shared coverage.
export function pairWallOutlines(walls:Wall[]):Wall[]{
 const used=new Set<string>(),result:Wall[]=[];
 for(const a of [...walls].sort((a,b)=>Math.hypot(b.x2-b.x1,b.z2-b.z1)-Math.hypot(a.x2-a.x1,a.z2-a.z1))){
  if(used.has(a.id))continue;
  const vertical=Math.abs(a.x2-a.x1)<.001;
  const axis=(w:Wall)=>vertical?w.x1:w.z1;
  const start=(w:Wall)=>vertical?w.z1:w.x1,end=(w:Wall)=>vertical?w.z2:w.x2;
  const candidates=walls.filter(b=>b.id!==a.id&&!used.has(b.id)&&(Math.abs(b.x2-b.x1)<.001)===vertical).map(b=>({b,d:Math.abs(axis(a)-axis(b)),lo:Math.max(start(a),start(b)),hi:Math.min(end(a),end(b))})).filter(v=>v.d>=.09&&v.d<=.38&&v.d>Math.max(a.thickness,v.b.thickness)*1.3&&(v.hi-v.lo)/Math.min(end(a)-start(a),end(v.b)-start(v.b))>.8&&v.hi-v.lo>.8).sort((a,b)=>a.d-b.d);
  const pair=candidates[0];
  if(pair){const c=(axis(a)+axis(pair.b))/2,lo=Math.min(start(a),start(pair.b)),hi=Math.max(end(a),end(pair.b));result.push({...a,x1:vertical?c:lo,z1:vertical?lo:c,x2:vertical?c:hi,z2:vertical?hi:c,thickness:pair.d+(a.thickness+pair.b.thickness)/2});used.add(pair.b.id);}else if(a.thickness>.06)result.push(a);
  used.add(a.id);
 }
 return result;
}
