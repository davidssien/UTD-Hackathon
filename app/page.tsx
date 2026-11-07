'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Armchair, Box, BrickWall, DoorOpen, Grid2X2, LoaderCircle, Redo2, Trash2, Undo2, Upload, X, AppWindow, PaintBucket, SquareDashed } from 'lucide-react';
import { detectWalls, readFloorplan } from '@/lib/floorplan';
import PlanEditor from '@/components/plan-editor';
import { editorReducer, initialEditor, type EditCommand, type Tool } from '@/lib/building-editor';
import type { ViewerHandle } from '@/components/building-viewer';

const BuildingViewer = dynamic(() => import('@/components/building-viewer'), {
  ssr: false,
  loading: () => <div className="loading"><LoaderCircle className="spin" size={22} /></div>,
});


export default function Home() {
  const [editor, dispatch] = useReducer(editorReducer, initialEditor);
  const building = editor.present;
  const [selectedWalls, setSelectedWalls] = useState<string[]>([]);
  useEffect(() => { setSelectedWalls(ids => ids.filter(id => building?.walls.some(w => w.id === id))); }, [building]);
  const [tool, setTool] = useState<Tool>('select');
  const [buildOpen, setBuildOpen] = useState(false);
  const [furnitureOpen, setFurnitureOpen] = useState(false);
  const [cancelToken, setCancelToken] = useState(0);
  const commit = useCallback((command: EditCommand) => dispatch({ type: 'edit', command }), []);
  const [source, setSource] = useState('/sample-plan.svg');
  const [tab, setTab] = useState<'model' | 'plan'>('model');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const viewer = useRef<ViewerHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sourceRef = useRef('/sample-plan.svg');
  const generation = useRef(0);

  const generate = useCallback(async (url: string) => {
    const id = ++generation.current;
    setBusy(true);
    setError('');
    try {
      const canvas = await readFloorplan(url);
      const ctx = canvas.getContext('2d')!;
      const result = detectWalls(ctx.getImageData(0, 0, canvas.width, canvas.height), 20, 115, 5);
      if (id !== generation.current) return;
      if (!result.walls.length) throw new Error('No walls found. Try a clear floor plan with dark walls on a light background.');
      if (result.walls.length > 2000) throw new Error('This plan is too detailed. Crop it to the building and try again.');
      dispatch({ type: 'load', building: result });
      setTool('select');
    } catch (e) {
      if (id === generation.current) setError(e instanceof Error ? e.message : 'This floor plan could not be read.');
    } finally {
      if (id === generation.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    void generate('/sample-plan.svg');
    return () => { generation.current++; };
  }, [generate]);

  useEffect(() => () => {
    if (sourceRef.current.startsWith('blob:')) URL.revokeObjectURL(sourceRef.current);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName)) return;
      if (e.repeat) return;
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault(); viewer.current?.cancelBuild(); setCancelToken(n => n + 1);
        dispatch({ type: e.shiftKey ? 'redo' : 'undo' }); return;
      }
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') { e.preventDefault(); dispatch({ type: 'redo' }); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedWalls.length && tab === 'model') { e.preventDefault(); dispatch({ type: 'edit', command: { type: 'delete-walls', wallIds: selectedWalls } }); return; }
      if (e.key === 'Escape') { setSelectedWalls([]); setTool('select'); setBuildOpen(false); setFurnitureOpen(false); setCancelToken(n => n + 1); viewer.current?.cancelBuild(); }
      if (tab !== 'model') return;
      if (e.code === 'Numpad7' || e.key === '7') viewer.current?.view('top');
      if (e.code === 'Numpad1' || e.key === '1') viewer.current?.view('front');
      if (e.code === 'Numpad0' || e.key.toLowerCase() === 'f') viewer.current?.view('fit');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, selectedWalls]);

  const upload = async (file?: File) => {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError('Choose a PNG, JPG, or WebP image.');
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setError('Choose an image smaller than 20 MB.');
      return;
    }
    const url = URL.createObjectURL(file);
    if (sourceRef.current.startsWith('blob:')) URL.revokeObjectURL(sourceRef.current);
    sourceRef.current = url;
    setSource(url);
    dispatch({ type: 'load', building: null });
    setTab('plan');
    await generate(url);
  };

  return (
    <main
      className={`workspace ${dragging ? 'dragging' : ''}`}
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={e => { e.preventDefault(); setDragging(false); void upload(e.dataTransfer.files[0]); }}
    >
      <input
        className="sr-only"
        ref={fileInput}
        type="file"
        aria-label="Upload floor plan image"
        accept="image/png,image/jpeg,image/webp"
        onChange={e => { void upload(e.target.files?.[0]); e.target.value = ''; }}
      />

      <div className={tab === 'model' ? 'viewer-layer' : 'viewer-layer hidden'} aria-hidden={tab !== 'model'}>
        <BuildingViewer
          ref={viewer}
          active={tab === 'model'}
          building={building}
          sceneKey={source}
          tool={tool}
          onEdit={commit}
          selectedWalls={selectedWalls}
          onSelectionChange={setSelectedWalls}
        />
      </div>

      {tab === 'plan' && (
        <section className="floor-plan" aria-label="Floor plan workspace">
          {building ? <PlanEditor building={building} source={source} tool={tool} cancelToken={cancelToken} onEdit={commit} /> : <div className="plan-image"><img src={source} alt="Source floor plan" /></div>}
          <button className="upload-button" onClick={() => fileInput.current?.click()}>
            <Upload size={16} /> Upload floor plan
          </button>
        </section>
      )}

      <nav className="view-tabs" aria-label="Workspace views">
        <button
          className={tab === 'model' ? 'active' : ''}
          aria-current={tab === 'model' ? 'page' : undefined}
          title="Right-drag to orbit · Scroll to zoom · Shift-click or drag to select walls · F to frame"
          onClick={() => setTab('model')}
        >
          <Box size={17} /> 3D model
        </button>
        <button
          className={tab === 'plan' ? 'active' : ''}
          aria-current={tab === 'plan' ? 'page' : undefined}
          onClick={() => { setTab('plan'); setCancelToken(n => n + 1); }}
        >
          <Grid2X2 size={17} /> Floor plan
        </button>
      </nav>

      {building && <>
        {buildOpen && <div className="furniture-picker build-picker" aria-label="Build options">
          <button className={tool === 'wall' ? 'active' : ''} onClick={() => { setTool('wall'); setBuildOpen(false); }}><BrickWall size={23}/><strong>Walls</strong><span>Draw one segment</span></button>
          <button className={tool === 'floor' ? 'active' : ''} onClick={() => { setTool('floor'); setBuildOpen(false); }}><SquareDashed size={23}/><strong>Draw floor</strong><span>Choose two corners</span></button>
          <button className={tool === 'fill-floor' ? 'active' : ''} onClick={() => { setTool('fill-floor'); setBuildOpen(false); }}><PaintBucket size={23}/><strong>Fill room</strong><span>Click enclosed space</span></button>
        </div>}
        {furnitureOpen && <div className="furniture-picker" aria-label="Doors and windows">
          <button className={tool === 'door' ? 'active' : ''} onClick={() => { setTool('door'); setFurnitureOpen(false); }}><DoorOpen size={23}/><strong>Door</strong><span>0.9 × 2.1 m</span></button>
          <button className={tool === 'window' ? 'active' : ''} onClick={() => { setTool('window'); setFurnitureOpen(false); }}><AppWindow size={23}/><strong>Window</strong><span>1.2 × 1.2 m</span></button>
        </div>}
        <div className={`build-instruction ${editor.past.length || editor.future.length || selectedWalls.length ? 'with-utilities' : ''}`} role="status">{tool === 'wall' ? 'Click start and end · Each wall finishes separately · Shift for angles · Esc to exit' : tool === 'floor' ? 'Click or drag between two corners to draw a floor · Esc to exit' : tool === 'fill-floor' ? 'Click inside an enclosed room to fill its floor · Esc to exit' : tool === 'door' || tool === 'window' ? `Click a wall to place a ${tool} · Esc to finish` : tool === 'delete' ? 'Click a wall, door, or window to remove it · Esc to finish' : tab === 'model' ? 'Right-drag to orbit · Scroll to zoom · Shift-click or drag to select walls' : 'Choose a tool to edit your floor plan'}</div>
        <nav className="build-toolbar" aria-label="Building tools">
          <button aria-pressed={tool === 'wall' || tool === 'floor' || tool === 'fill-floor' || buildOpen} aria-expanded={buildOpen} className={tool === 'wall' || tool === 'floor' || tool === 'fill-floor' || buildOpen ? 'active' : ''} onClick={() => { setBuildOpen(!buildOpen); setFurnitureOpen(false); }}><BrickWall size={23}/><span>Build<small>Walls & floors</small></span></button>
          <button aria-pressed={tool === 'door' || tool === 'window' || furnitureOpen} aria-expanded={furnitureOpen} className={tool === 'door' || tool === 'window' || furnitureOpen ? 'active' : ''} onClick={() => { setFurnitureOpen(!furnitureOpen); setBuildOpen(false); }}><Armchair size={23}/><span>Furniture<small>Doors & windows</small></span></button>
          <button aria-pressed={tool === 'delete'} className={tool === 'delete' ? 'active delete-active' : ''} onClick={() => { setTool(tool === 'delete' ? 'select' : 'delete'); setBuildOpen(false); setFurnitureOpen(false); }}><Trash2 size={22}/><span>Delete<small>Remove objects</small></span></button>
        </nav>
        {(editor.past.length > 0 || editor.future.length > 0 || selectedWalls.length > 0) && <div className="edit-utilities">
          {selectedWalls.length > 0 && tab === 'model' && <div className="selection-actions"><span>{selectedWalls.length} wall{selectedWalls.length === 1 ? '' : 's'} selected</span><button aria-label="Delete selected walls" title="Delete selected walls and all attachments" onClick={() => commit({ type: 'delete-walls', wallIds: selectedWalls })}><Trash2 size={15}/></button><button aria-label="Clear wall selection" onClick={() => setSelectedWalls([])}><X size={15}/></button></div>}
          {(editor.past.length > 0 || editor.future.length > 0) && <div className="history-buttons"><button aria-label="Undo" title="Undo (Ctrl/⌘ Z)" disabled={!editor.past.length} onClick={() => { viewer.current?.cancelBuild(); setCancelToken(n => n + 1); dispatch({ type: 'undo' }); }}><Undo2 size={16}/></button><button aria-label="Redo" title="Redo (Ctrl/⌘ Shift Z)" disabled={!editor.future.length} onClick={() => { viewer.current?.cancelBuild(); setCancelToken(n => n + 1); dispatch({ type: 'redo' }); }}><Redo2 size={16}/></button></div>}
        </div>}
      </>}

      {busy && <div className="loading" role="status"><LoaderCircle className="spin" size={23} /><span>Reading floor plan…</span></div>}
      {!building && !busy && tab === 'model' && <div className="empty-model">Upload a clear floor plan to generate a 3D model.</div>}
      {dragging && <div className="drop-overlay"><Upload size={28} />Drop your floor plan here</div>}
      {(error || editor.error) && (
        <div role="alert" className="error-toast">
          <span>{error || editor.error}</span>
          <button aria-label="Dismiss error" onClick={() => { setError(''); dispatch({ type: 'clear-error' }); }}><X size={17} /></button>
        </div>
      )}
    </main>
  );
}
