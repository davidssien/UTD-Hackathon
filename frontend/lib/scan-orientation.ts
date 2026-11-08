import { pairWallOutlines } from './scan-wall-pairs.ts';
import { detectWalls, type Building } from './floorplan.ts';

// Rotate into an expanded image so corner strokes are never cropped. Coordinates
// are mapped back to the source after detection; the reference image stays intact.
export function rotateScan(image: ImageData, angle: number, maxSize = Infinity) {
  const scale=Math.min(1,maxSize/Math.max(image.width,image.height));
  const c=Math.cos(angle),s=Math.sin(angle);
  const width=Math.ceil(scale*(Math.abs(c)*image.width+Math.abs(s)*image.height));
  const height=Math.ceil(scale*(Math.abs(s)*image.width+Math.abs(c)*image.height));
  const data=new Uint8ClampedArray(width*height*4).fill(255);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const dx=(x-width/2)/scale,dy=(y-height/2)/scale;
    const sx=Math.round(c*dx+s*dy+image.width/2),sy=Math.round(-s*dx+c*dy+image.height/2);
    if(sx<0||sy<0||sx>=image.width||sy>=image.height)continue;
    const from=(sy*image.width+sx)*4,to=(y*width+x)*4;
    data[to]=image.data[from];data[to+1]=image.data[from+1];data[to+2]=image.data[from+2];
  }
  return {width,height,data} as ImageData;
}
export function detectOrientedWalls(image:ImageData): {building:Building; rotation:number} {
  const score=(b:Building)=>b.walls.reduce((sum,w)=>sum+Math.hypot(w.x2-w.x1,w.z2-w.z1)**2*w.thickness,0);
  let bestAngle=0,bestScore=-1;
  // Coarse-to-fine search uses small images; only the chosen orientation is
  // vectorized at full resolution. No line is fabricated to complete a room.
  const evaluate=(degrees:number)=>{
    const sample=rotateScan(image,degrees*Math.PI/180,400);
    const result=detectWalls(sample,20*sample.width/(Math.min(1,400/Math.max(image.width,image.height))*image.width),115,3);
    const value=score(result);
    if(value>bestScore){bestScore=value;bestAngle=degrees;}
  };
  evaluate(0);
  for(let angle=-45;angle<=45;angle+=5)evaluate(angle);
  const coarse=bestAngle;
  for(let angle=coarse-4;angle<=coarse+4;angle++)evaluate(angle);
  const angle=bestAngle*Math.PI/180,rotated=rotateScan(image,angle);
  const detected=detectWalls(rotated,20*rotated.width/image.width,115,1.5,1);
  const raw={...detected,walls:pairWallOutlines(detected.walls)};
  const c=Math.cos(angle),s=Math.sin(angle);
  const point=(x:number,z:number)=>({x:c*x+s*z,z:-s*x+c*z});
  return {rotation:bestAngle,building:{...raw,width:20,depth:20*image.height/image.width,sourceWidth:image.width,sourceHeight:image.height,walls:raw.walls.map(w=>{
    const a=point(w.x1,w.z1),b=point(w.x2,w.z2);
    return {...w,x1:a.x,z1:a.z,x2:b.x,z2:b.z};
  })}};
}
