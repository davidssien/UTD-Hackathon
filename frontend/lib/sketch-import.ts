import { detectWalls, type Building } from './floorplan.ts';
import { joinWallEndpoints, wallLength, projectOnWall, editBuilding } from './building-editor.ts';
import { enclosedRooms } from './rooms.ts';

export type Recognition = { building: Building; warnings: string[]; confidence: 'review-required'; method: string };
// Local contrast enhancement removes broad paper shadows while retaining dark strokes.
export function preprocessSketch(image: ImageData): ImageData {
  const { width, height, data } = image;
  const gray = new Float64Array(width*height), integral = new Float64Array((width+1)*(height+1));
  for (let y=0;y<height;y++) { let sum=0; for (let x=0;x<width;x++) {
    const i=y*width+x, a=data[i*4+3]/255;
    gray[i]=(.2126*data[i*4]+.7152*data[i*4+1]+.0722*data[i*4+2])*a+255*(1-a);
    sum+=gray[i]; integral[(y+1)*(width+1)+x+1]=integral[y*(width+1)+x+1]+sum;
  }}
  const output = new Uint8ClampedArray(data.length).fill(255), radius=Math.max(8,Math.round(Math.max(width,height)/30));
  for (let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const x0=Math.max(0,x-radius),x1=Math.min(width,x+radius+1),y0=Math.max(0,y-radius),y1=Math.min(height,y+radius+1);
    const mean=(integral[y1*(width+1)+x1]-integral[y0*(width+1)+x1]-integral[y1*(width+1)+x0]+integral[y0*(width+1)+x0])/((x1-x0)*(y1-y0));
    const v=gray[y*width+x]<Math.min(210,mean-18)?0:255, i=(y*width+x)*4;
    output[i]=output[i+1]=output[i+2]=v;
  }
  return { width,height,data:output } as ImageData;
}
export function recognizeSketch(image: ImageData): Recognition {
  const raw = detectWalls(preprocessSketch(image),20,115,3);
  if (raw.walls.length>500) throw new Error('Too many marks to review. Crop the plan or use manual tracing.');
  const walls=joinWallEndpoints(raw.walls);
  for (const wall of walls) for (const end of ['start','end'] as const) {
    const p=end==='start'?{x:wall.x1,z:wall.z1}:{x:wall.x2,z:wall.z2};
    let closest:ReturnType<typeof projectOnWall>|undefined;
    for(const other of walls) {
      if(other.id===wall.id)continue;
      const projected=projectOnWall(other,p);
      if(projected.distance<.2&&(!closest||projected.distance<closest.distance))closest=projected;
    }
    if(closest){if(end==='start'){wall.x1=closest.x;wall.z1=closest.z;}else{wall.x2=closest.x;wall.z2=closest.z;}}
  }
  const building={...raw,walls,floorBounds:null};
  return {building,confidence:'review-required',method:'Local contrast + line extraction',warnings:[
    'Scale is estimated. Select a wall and enter its known length before trusting dimensions.',
    'Local recognition finds near-horizontal and vertical strokes; perspective, symbols, labels and dimensions require review.',
    ...(!walls.length?['No reliable walls found. Trace walls over the image using the tools below.']:[]),
    ...(!enclosedRooms(walls).length?['No closed rooms found. Close wall gaps before generating room floors.']:[]),
  ]};
}
export function transformImport(building: Building, scale=1, rotation=0, x=0, z=0): Building {
  if (![scale,rotation,x,z].every(Number.isFinite)||scale<=0||scale>100) throw new Error('Choose a valid placement and scale.');
  const angle=rotation*Math.PI/180, c=Math.cos(angle), s=Math.sin(angle);
  const point=(px:number,pz:number)=>({x:scale*(px*c-pz*s)+x,z:scale*(px*s+pz*c)+z});
  return {...building,width:building.width*scale,depth:building.depth*scale,floorBounds:null,
    walls:building.walls.map(w=>{const a=point(w.x1,w.z1),b=point(w.x2,w.z2);return {...w,x1:a.x,z1:a.z,x2:b.x,z2:b.z,thickness:w.thickness*scale,openings:w.openings?.map(o=>({...o,offset:o.offset*scale,width:o.width*scale}))};}),
    floors:building.floors?.map(f=>({...f,points:f.points.map(p=>point(p.x,p.z))}))};
}
export function importWarnings(building:Building): string[] {
  const warnings:string[]=[];
  for (const w of building.walls) {
    if (wallLength(w)<.5) warnings.push('Some walls are shorter than 0.5 m.');
    for(const p of [{x:w.x1,z:w.z1},{x:w.x2,z:w.z2}]) if (!building.walls.some(other=>other.id!==w.id&&projectOnWall(other,p).distance<.02)) { warnings.push('Some wall ends are disconnected. Check intentional door gaps.'); break; }
  }
  return [...new Set(warnings)];
}
export function mergeImport(current: Building, imported: Building): {building:Building;error?:string} {
  if (!imported.walls.length) return {building:current,error:'Trace or recognize at least one wall first.'};
  let candidate=current;
  for(const wall of imported.walls) {
    for(const existing of current.walls) {
      const ax=wall.x2-wall.x1,az=wall.z2-wall.z1,bx=existing.x2-existing.x1,bz=existing.z2-existing.z1;
      const cross=ax*bz-az*bx;
      if(Math.abs(cross)<1e-7)continue;
      const dx=existing.x1-wall.x1,dz=existing.z1-wall.z1;
      const t=(dx*bz-dz*bx)/cross,u=(dx*az-dz*ax)/cross;
      if(t>1e-5&&t<1-1e-5&&u>1e-5&&u<1-1e-5)return {building:current,error:'Imported walls cross existing walls. Move or rotate the layout before confirming.'};
    }
    const result=editBuilding(candidate,{type:'wall',start:{x:wall.x1,z:wall.z1},end:{x:wall.x2,z:wall.z2}});
    if(result.error) return {building:current,error:`Import cannot be placed: ${result.error}`};
    candidate={...result.building,walls:[...candidate.walls,{...wall,id:crypto.randomUUID(),openings:wall.openings?.map(o=>({...o,id:crypto.randomUUID()}))}]};
  }
  return {building:{...candidate,references:[...(current.references??[]),...(imported.references??[])],importInfo: imported.importInfo && !imported.importInfo.calibrated ? imported.importInfo : current.importInfo,floors:[...(current.floors??[]),...(imported.floors??[]).map(f=>({...f,id:crypto.randomUUID()}))]}};
}
