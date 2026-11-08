'use client';
import { useEffect, useRef, useState } from 'react';
import { X, Upload, Smartphone, BrickWall, DoorOpen, AppWindow, MousePointer2, Trash2 } from 'lucide-react';
import PlanEditor from './plan-editor';
import { readFloorplan, type Building } from '@/lib/floorplan';
import { editBuilding, wallLength, type Tool } from '@/lib/building-editor';
import { recognizeSketch, transformImport, importWarnings, mergeImport } from '@/lib/sketch-import';
import { enclosedRooms } from '@/lib/rooms';

type Pairing={id:string;token:string;expires:number;url:string;qr:string};
type Props={current:Building|null;initialFile?:File;onClose:()=>void;onImport:(building:Building,append:boolean)=>void};
export default function SketchImporter({current,initialFile,onClose,onImport}:Props) {
  const [pair,setPair]=useState<Pairing|null>(null),[pairError,setPairError]=useState('');
  const [source,setSource]=useState(''),[draft,setDraft]=useState<Building|null>(null);
  const [stage,setStage]=useState(''),[error,setError]=useState(''),[warnings,setWarnings]=useState<string[]>([]);
  const [tool,setTool]=useState<Tool>('select'),[selected,setSelected]=useState<string[]>([]);
  const [layers,setLayers]=useState({walls:true,openings:true,reference:true});
  const [known,setKnown]=useState(''),[calibrated,setCalibrated]=useState(false);
  const [append,setAppend]=useState(false),[x,setX]=useState(0),[z,setZ]=useState(0),[rotation,setRotation]=useState(0);
  const [traceOnly,setTraceOnly]=useState(false);
  const requestId=useRef(0),started=useRef(false);
  const analyze=async(url:string)=>{
    const id=++requestId.current;
    setError('');setStage('Reading image…');setSource(url);setDraft(null);setCalibrated(false);setSelected([]);
    try{
      const canvas=await readFloorplan(url); if(id!==requestId.current)return;
      setStage('Enhancing contrast and extracting wall lines…');
      await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
      const result=recognizeSketch(canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height));
      if(id!==requestId.current)return;
      setDraft(result.building);setWarnings(result.warnings);setTraceOnly(!result.building.walls.length);
    }catch(e){if(id===requestId.current){setError(e instanceof Error?e.message:'This plan could not be read.');
      try { const canvas=await readFloorplan(url); if(id!==requestId.current)return; setDraft({walls:[],width:20,depth:20*canvas.height/canvas.width,sourceWidth:canvas.width,sourceHeight:canvas.height,floorBounds:null});setTraceOnly(true);setWarnings(['Automatic recognition failed. Use Trace wall to draw over the original.']); } catch { /* An undecodable image cannot be traced. */ }
    }}
    finally{if(id===requestId.current)setStage('');}
  };
  const file=async(f?:File)=>{
    if(!f)return;
    if(!['image/png','image/jpeg','image/webp'].includes(f.type)||f.size>10*1024*1024){setError('Choose a PNG, JPEG, or WebP smaller than 10 MB.');return;}
    try{const url=await new Promise<string>((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result as string);r.onerror=reject;r.readAsDataURL(f);});await analyze(url);}catch{setError('This image could not be read.');}
  };
  useEffect(()=>()=>{requestId.current++;},[]);
  useEffect(()=>{if(initialFile&&!started.current){started.current=true;void file(initialFile);}},[initialFile]);
  useEffect(()=>{
    if(!pair||source)return;
    let disposed=false,timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      try{
        const response=await fetch(`/api/import-sessions/${pair.id}`,{headers:{Authorization:`Bearer ${pair.token}`},cache:'no-store'});
        const result=await response.json();if(disposed)return;
        if(!response.ok)throw new Error(result.error);
        if(result.image){await analyze(result.image);return;}
        timer=setTimeout(poll,1500);
      }catch(e){if(!disposed)setPairError(e instanceof Error?e.message:'Connection lost. Create a new QR code.');}
    };void poll();
    return()=>{disposed=true;clearTimeout(timer);};
  },[pair,source]);
  useEffect(()=>()=>{if(pair)void fetch(`/api/import-sessions/${pair.id}`,{method:'DELETE',headers:{Authorization:`Bearer ${pair.token}`},keepalive:true});},[pair]);
  const pairing=async()=>{
    setPairError('');
    try{const response=await fetch('/api/import-sessions',{method:'POST'});const result=await response.json();if(!response.ok)throw new Error(result.error);setPair(result);}
    catch(e){setPairError(e instanceof Error?e.message:'Could not create a QR code.');}
  };
  const choose=(next:Tool)=>{setTool(tool===next?'select':next);setError('');};
  let placed:Building|null=null,placementError='';
  if(draft)try{placed=transformImport(draft,1,rotation,x,z);if(append&&current)placementError=mergeImport(current,placed).error??'';}catch(e){placementError=e instanceof Error?e.message:'Invalid placement.';}
  const allWalls=[...(current?.walls??[]),...(placed?.walls??[])];
  const minX=Math.min(-10,...allWalls.map(w=>Math.min(w.x1,w.x2)))-2;
  const minZ=Math.min(-10,...allWalls.map(w=>Math.min(w.z1,w.z2)))-2;
  const placementViewBox=`${minX} ${minZ} ${Math.max(10,...allWalls.map(w=>Math.max(w.x1,w.x2)))-minX+2} ${Math.max(10,...allWalls.map(w=>Math.max(w.z1,w.z2)))-minZ+2}`;
  const generate=()=>{
    if(!placed?.walls.length||placementError)return;
    const floors=enclosedRooms(placed.walls).map(points=>({id:crypto.randomUUID(),points,kind:'room' as const}));
    onImport({...placed,floors,references:append?[{image:source,width:draft!.width,depth:draft!.depth,x,z,rotation}]:[],importInfo:{calibrated,method:'Local line recognition with manual review',warnings},referenceImage:append?current?.referenceImage:source},append);onClose();
  };
  return <section className="import-dialog" aria-labelledby="import-title" onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();onClose();}e.stopPropagation();}}>
    <header><div><span className="import-eyebrow">SKETCH TO HOUSE</span><h1 id="import-title">Bring your plan to life.</h1></div><button aria-label="Close import" onClick={onClose}><X size={20}/></button></header>
    {!draft?<div className="import-upload"><p>A clear plan works best. Nothing in your building changes until you confirm.</p><label className="import-action"><Upload size={19}/> Choose a floor plan<input className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" disabled={!!stage} onChange={e=>void file(e.target.files?.[0])}/></label><button onClick={pairing} disabled={!!stage}><Smartphone size={18}/> {pair?'Refresh QR code':'Use your phone'}</button>{pair&&<div className="qr-pair"><img src={pair.qr} alt="QR code for phone upload"/><div><strong>Scan, snap, send.</strong><p>Use the same Wi-Fi network, or a configured HTTPS tunnel. This link expires in 15 minutes.</p><a href={pair.url} target="_blank" rel="noreferrer">Open upload page</a><p className="pair-url">{pair.url.split('#')[0]}</p></div></div>}{pairError&&<p role="alert">{pairError}</p>}{stage&&<p role="status">{stage}</p>}</div>:<>
      <div className="import-review">
        <section className="import-canvas"><div className="review-layers">{(['reference','walls','openings'] as const).map(key=><label key={key}><input type="checkbox" checked={layers[key]} onChange={e=>setLayers({...layers,[key]:e.target.checked})}/>{key}</label>)}</div>
          {append&&placed?<svg viewBox={placementViewBox} aria-label="Import placement preview">{current!.walls.map(w=><line key={w.id} x1={w.x1} y1={w.z1} x2={w.x2} y2={w.z2} stroke="#88998c" strokeWidth={w.thickness}/>)}{placed.walls.map(w=><line key={w.id} x1={w.x1} y1={w.z1} x2={w.x2} y2={w.z2} stroke={placementError?'#c65f4b':'#427b64'} opacity=".65" strokeWidth={w.thickness}/>)}</svg>:<PlanEditor building={draft} source={layers.reference?source:''} tool={tool} cancelToken={0} selectedWalls={selected} onSelectionChange={setSelected} layers={layers} onEdit={command=>{const result=editBuilding(draft,command);setError(result.error??'');if(result.error)setTool('select');else setDraft(result.building);}}/>}
        </section>
        <aside><span className="import-eyebrow">REVIEW REQUIRED · {calibrated?'CALIBRATED':'ESTIMATED SCALE'}</span><p>{draft.walls.length} walls · {enclosedRooms(draft.walls).length} closed rooms</p><p>Automatic line extraction only. Doors, windows and room labels are not inferred by the local detector.</p><div className="review-tools">{([{tool:'select',label:'Select',icon:MousePointer2},{tool:'wall',label:'Trace wall',icon:BrickWall},{tool:'door',label:'Door',icon:DoorOpen},{tool:'window',label:'Window',icon:AppWindow},{tool:'delete',label:'Delete',icon:Trash2}] as const).map(t=><button key={t.tool} disabled={append} aria-pressed={tool===t.tool} onClick={()=>choose(t.tool)}><t.icon size={16}/>{t.label}</button>)}</div><p>Select a wall and drag its endpoints to correct it. Delete a mistaken opening, then choose Door or Window to replace it.</p>
        <label>Known length of selected wall (m)<input type="number" min="0.5" max="1000" step="0.1" value={known} onChange={e=>setKnown(e.target.value)}/></label><button disabled={!selected.length||!Number.isFinite(Number(known))||Number(known)<=0} onClick={()=>{const wall=draft.walls.find(w=>w.id===selected[0]);if(wall){const ratio=Number(known)/wallLength(wall);try{setDraft(transformImport(draft,ratio));setCalibrated(true);setError('');}catch(e){setError((e as Error).message);}}}}>Calibrate scale</button>
        <label><input type="checkbox" checked={append} disabled={!current} onChange={e=>{setAppend(e.target.checked);setTool('select');}}/> Add to current ground floor</label>{append&&<><label>Move X (m)<input type="number" step=".5" value={x} onChange={e=>setX(Number(e.target.value))}/></label><label>Move Z (m)<input type="number" step=".5" value={z} onChange={e=>setZ(Number(e.target.value))}/></label><label>Rotate (degrees)<input type="number" step="90" value={rotation} onChange={e=>setRotation(Number(e.target.value))}/></label><p>Green is the imported layout; gray is your existing building. Adjust placement before confirming.</p></>}
        <details><summary>Recognition notes</summary>{[...warnings.filter(w=>!calibrated||!w.startsWith('Scale')), ...importWarnings(draft)].map((w,i)=><p key={i}>{w}</p>)}</details>{traceOnly&&<p>No automatic structure was accepted. Trace walls over the original image.</p>}</aside>
      </div><footer><p>{placementError||error||'Review every wall and opening before generating. Dimensions are approximate until calibrated.'}</p><button disabled={!draft.walls.length||!!placementError} onClick={generate}>{append?'Add to current building':'Generate Building'}</button></footer>
    </>}{error&&!draft&&<p role="alert">{error}</p>}
  </section>;
}
