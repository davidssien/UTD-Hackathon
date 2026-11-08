import type { Building, Wall } from './floorplan.ts';
import { wallLength, projectOnWall } from './building-editor.ts';
import { enclosedRooms } from './rooms.ts';

export type ScanGap = { id: string; wall: Wall; width: number; offset: number; evidence?: 'door' | 'window'; remove: string[] };
// Small disconnected objects and thin strokes are retained for review, not lost.
export function structuralWalls(walls: Wall[]) {
  const longest = [...walls].sort((a,b)=>wallLength(b)-wallLength(a)).slice(0,8);
  const thickness = [...longest].sort((a,b)=>a.thickness-b.thickness)[Math.floor(longest.length/2)]?.thickness ?? .1;
  const thick = walls.filter(w=>w.thickness >= thickness*.55);
  const groups: Wall[][]=[];
  const remaining=new Set(thick);
  while(remaining.size){
    const group=[remaining.values().next().value!]; remaining.delete(group[0]);
    for(let i=0;i<group.length;i++) for(const w of remaining){
      const a=group[i];
      const touches=[{x:a.x1,z:a.z1},{x:a.x2,z:a.z2}].some(p=>projectOnWall(w,p).distance<Math.max(.22,thickness)) || [{x:w.x1,z:w.z1},{x:w.x2,z:w.z2}].some(p=>projectOnWall(a,p).distance<Math.max(.22,thickness));
      if(touches){group.push(w);remaining.delete(w);}
    }
    groups.push(group);
  }
  const extent=(g:Wall[])=>Math.hypot(Math.max(...g.flatMap(w=>[w.x1,w.x2]))-Math.min(...g.flatMap(w=>[w.x1,w.x2])),Math.max(...g.flatMap(w=>[w.z1,w.z2]))-Math.min(...g.flatMap(w=>[w.z1,w.z2])));
  const largest=Math.max(0,...groups.map(extent));
  const accepted=groups.filter(g=>extent(g)>=largest*.28).flat();
  const ids=new Set(accepted.map(w=>w.id));
  return {walls:accepted,ignored:walls.filter(w=>!ids.has(w.id))};
}

export function scanGaps(walls:Wall[], marks:Wall[]=walls): ScanGap[] {
  const gaps:ScanGap[]=[];
  for(let i=0;i<walls.length;i++)for(let j=i+1;j<walls.length;j++){
    const a=walls[i],b=walls[j],length=wallLength(a),bl=wallLength(b);
    if(!length||!bl)continue;
    const ux=(a.x2-a.x1)/length,uz=(a.z2-a.z1)/length;
    if(Math.abs(ux*(b.z2-b.z1)/bl-uz*(b.x2-b.x1)/bl)>.025)continue;
    const along=(x:number,z:number)=>(x-a.x1)*ux+(z-a.z1)*uz;
    const off=(x:number,z:number)=>Math.abs((x-a.x1)*uz-(z-a.z1)*ux);
    if(Math.max(off(b.x1,b.z1),off(b.x2,b.z2))>Math.min(a.thickness,b.thickness)*.55)continue;
    const lo=Math.min(along(b.x1,b.z1),along(b.x2,b.z2)),hi=Math.max(along(b.x1,b.z1),along(b.x2,b.z2));
    const start=lo>length?length:hi<0?hi:NaN,end=lo>length?lo:hi<0?0:NaN,gap=end-start;
    if(!Number.isFinite(gap)||gap<Math.max(.25,a.thickness)||gap>Math.min(2.5,Math.max(length,bl)*.6))continue;
    const middle={x:a.x1+ux*(start+end)/2,z:a.z1+uz*(start+end)/2};
    if(walls.some(w=>w!==a&&w!==b&&projectOnWall(w,middle).distance<Math.max(.12,a.thickness)))continue;
    const symbols=marks.filter(w=>w!==a&&w!==b&&w.thickness<Math.min(a.thickness,b.thickness)*.7);
    const windows=symbols.filter(w=>Math.abs(ux*(w.z2-w.z1)-uz*(w.x2-w.x1))/wallLength(w)<.08 && off(w.x1,w.z1)<a.thickness && off(w.x2,w.z2)<a.thickness && Math.min(along(w.x1,w.z1),along(w.x2,w.z2))<start+gap*.25 && Math.max(along(w.x1,w.z1),along(w.x2,w.z2))>end-gap*.25);
    const doors=symbols.filter(w=>Math.abs(ux*(w.x2-w.x1)+uz*(w.z2-w.z1))/wallLength(w)<.12 && wallLength(w)>gap*.65 && wallLength(w)<gap*1.3 && [{x:w.x1,z:w.z1},{x:w.x2,z:w.z2}].some(p=>off(p.x,p.z)<a.thickness && Math.min(Math.abs(along(p.x,p.z)-start),Math.abs(along(p.x,p.z)-end))<a.thickness));
    // Keep both original hosts and bridge only the gap. Endpoint openings are
    // allowed here: the adjacent host sections provide the jambs.
    const bStart=along(b.x1,b.z1)<along(b.x2,b.z2);
    const left=lo>length?{x:a.x2,z:a.z2}:bStart?{x:b.x2,z:b.z2}:{x:b.x1,z:b.z1};
    const right=lo>length?(bStart?{x:b.x1,z:b.z1}:{x:b.x2,z:b.z2}):{x:a.x1,z:a.z1};
    const wall:Wall={id:`gap-${a.id}-${b.id}`,x1:left.x,z1:left.z,x2:right.x,z2:right.z,thickness:Math.max(a.thickness,b.thickness)};
    gaps.push({id:wall.id,wall,width:wallLength(wall),offset:wallLength(wall)/2,evidence:windows.length?'window':doors.length?'door':undefined,remove:[...windows,...doors].map(w=>w.id)});
  }
  return gaps;
}
export function closeScanGap(building:Building,gap:ScanGap,kind:'door'|'window'|'wall'):Building {
  const wall={...gap.wall,openings:kind==='wall'?[]:[{id:`${gap.id}-opening`,type:kind,offset:gap.offset,width:gap.width,height:kind==='door'?2.1:1.2,sill:kind==='door'?0:.9}]};
  return refreshScanFloors({...building,walls:[...building.walls.filter(w=>!gap.remove.includes(w.id)),wall]});
}
export function refreshScanFloors(building:Building):Building {
  return {...building,floorBounds:null,floors:[...(building.floors??[]).filter(f=>f.kind==='drawn'),...enclosedRooms(building.walls).map((points,i)=>({id:`detected-room-${i}`,points,kind:'room' as const}))]};
}

// A rectangular exterior can support a continuous floor even while interior
// doorway symbols remain unresolved. Require evidence along every side; never
// infer a rectangle from two walls or from a sparse collection of furniture.
export function rectangularFootprint(walls:Wall[]) {
 if(walls.length<4)return null;
 const vertical=walls.filter(w=>Math.abs(w.x2-w.x1)<Math.abs(w.z2-w.z1)*.08),horizontal=walls.filter(w=>Math.abs(w.z2-w.z1)<Math.abs(w.x2-w.x1)*.08);
 const longestV=Math.max(0,...vertical.map(w=>Math.abs(w.z2-w.z1))),longestH=Math.max(0,...horizontal.map(w=>Math.abs(w.x2-w.x1)));
 const sides=vertical.filter(w=>Math.abs(w.z2-w.z1)>longestV*.3),ends=horizontal.filter(w=>Math.abs(w.x2-w.x1)>longestH*.4);
 if(sides.length<2||ends.length<2)return null;
 const minX=Math.min(...sides.map(w=>(w.x1+w.x2)/2)),maxX=Math.max(...sides.map(w=>(w.x1+w.x2)/2));
 const minZ=Math.min(...ends.map(w=>(w.z1+w.z2)/2)),maxZ=Math.max(...ends.map(w=>(w.z1+w.z2)/2));
 const width=maxX-minX,depth=maxZ-minZ;
 if(width<2||depth<2)return null;
 const tolerance=Math.min(width,depth)*.04;
 for(const [vertical,edge,lo,hi] of [[true,minX,minZ,maxZ],[true,maxX,minZ,maxZ],[false,minZ,minX,maxX],[false,maxZ,minX,maxX]] as const){
  const spans=walls.filter(w=>vertical?Math.abs(w.x1-edge)<tolerance&&Math.abs(w.x2-edge)<tolerance:Math.abs(w.z1-edge)<tolerance&&Math.abs(w.z2-edge)<tolerance).map(w=>vertical?[Math.min(w.z1,w.z2),Math.max(w.z1,w.z2)]:[Math.min(w.x1,w.x2),Math.max(w.x1,w.x2)]).sort((a,b)=>a[0]-b[0]);
  let cursor=lo,covered=0;
  for(const [start,end] of spans){if(start-cursor>(hi-lo)*.2)return null;covered+=Math.max(0,end-Math.max(cursor,start));cursor=Math.max(cursor,end);}
  if(covered/(hi-lo)<.75||hi-cursor>(hi-lo)*.2)return null;
 }
 return [{x:minX,z:minZ},{x:maxX,z:minZ},{x:maxX,z:maxZ},{x:minX,z:maxZ}];
}
