import test from 'node:test';
import assert from 'node:assert/strict';
import { recognizeSketch, transformImport, mergeImport } from '../lib/sketch-import.ts';
import { editorReducer, initialEditor } from '../lib/building-editor.ts';
import { decodeProject } from '../lib/project-storage.ts';
import { enclosedRooms } from '../lib/rooms.ts';
import type { Building } from '../lib/floorplan.ts';
function sketch(shadow=false) {
  const width=300,height=240,data=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const wall=((x>=30&&x<=35||x>=260&&x<=265)&&y>=30&&y<=205)||((y>=30&&y<=35||y>=200&&y<=205)&&x>=30&&x<=265);
    const value=wall?35:shadow?Math.round(170+70*x/width):255;
    const i=(y*width+x)*4;data[i]=data[i+1]=data[i+2]=value;data[i+3]=255;
  }
  return {width,height,data} as ImageData;
}
test('local recognition vectorizes clean and shaded strokes into native rooms',()=>{
  for(const shadow of [false,true]){
    const result=recognizeSketch(sketch(shadow));
    assert.equal(result.building.walls.length,4);
    assert.ok(enclosedRooms(result.building.walls).length>0);
    assert.equal(result.confidence,'review-required');
  }
});
test('blank recognition stays empty for manual tracing',()=>{
  const image=sketch();image.data.fill(255);
  assert.equal(recognizeSketch(image).building.walls.length,0);
});
const current:Building={width:20,depth:20,sourceWidth:300,sourceHeight:240,walls:[{id:'a',x1:0,z1:0,x2:4,z2:0,thickness:.2}]};
test('import placement rotates and calibrates hosted openings',()=>{
  const imported={...current,walls:[{...current.walls[0],openings:[{id:'door',type:'door' as const,offset:2,width:.9,height:2.1,sill:0}]}]};
  const result=transformImport(imported,2,90,10,5);
  assert.ok(Math.abs(result.walls[0].x2-10)<1e-6);assert.equal(result.walls[0].z2,13);
  assert.equal(result.walls[0].openings![0].offset,4);assert.throws(()=>transformImport(imported,NaN));
});
test('append rejects duplicate walls atomically and imports as one undoable edit',()=>{
  assert.ok(mergeImport(current,current).error);assert.equal(mergeImport(current,current).building,current);
  const imported=transformImport(current,1,0,0,5);
  const loaded=editorReducer(initialEditor,{type:'load',building:current});
  const added=editorReducer(loaded,{type:'edit',command:{type:'import',building:imported,append:true}});
  assert.equal(added.present!.walls.length,2);assert.equal(added.past.length,1);
  assert.equal(editorReducer(added,{type:'undo'}).present,loaded.present);
  assert.equal(editorReducer(editorReducer(added,{type:'undo'}),{type:'redo'}).present!.walls.length,2);
});
test('replacement keeps the reference through save and undo',()=>{
  const imported={...current,referenceImage:'data:image/png;base64,abc'};
  const state=editorReducer({...initialEditor,present:current},{type:'edit',command:{type:'import',building:imported,append:false}});
  assert.equal(decodeProject(JSON.stringify({version:1,source:imported.referenceImage,building:state.present})).building.referenceImage,imported.referenceImage);
  assert.equal(editorReducer(state,{type:'undo'}).present,current);
});
test('append refuses crossing an existing wall without changing current geometry',()=>{
  const crossing={...current,walls:[{id:'new',x1:2,z1:-2,x2:2,z2:2,thickness:.2}]};
  const result=mergeImport(current,crossing);assert.ok(result.error);assert.equal(result.building,current);
});
test('image recognition ignores furniture, recognizes a door leaf, and closes the floor boundary',async()=>{
 const {default:sharp}=await import('sharp');
 const {data,info}=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="480"><rect width="600" height="480" fill="white"/><path d="M270 60H60V410H530V60H310" stroke="black" stroke-width="10" fill="none"/><path d="M270 60V100" stroke="black" stroke-width="3"/><rect x="180" y="200" width="40" height="40" stroke="black" stroke-width="3" fill="none"/></svg>')).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 const result=recognizeSketch({width:info.width,height:info.height,data} as unknown as ImageData);
 assert.equal(result.building.walls.length,6);assert.equal(result.building.walls.flatMap(w=>w.openings??[])[0]?.type,'door');assert.equal(result.building.floors?.length,1);assert.ok(result.ignored.length>=4);
});
test('numeric review edits preserve sub-grid coordinates and undo restores geometry',()=>{
 const loaded=editorReducer(initialEditor,{type:'load',building:current});
 const result=editorReducer(loaded,{type:'edit',command:{type:'resize-wall',wallId:'a',endpoint:'end',point:{x:4.13,z:0},snap:false}});
 assert.equal(result.present!.walls[0].x2,4.13);assert.equal(editorReducer(result,{type:'undo'}).present,loaded.present);
});
