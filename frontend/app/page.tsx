'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Armchair, Box, BrickWall, DoorOpen, Grid2X2, LoaderCircle, Redo2, Trash2, Undo2, Upload, X, AppWindow, PaintBucket, SquareDashed } from 'lucide-react';
import { detectWalls, readFloorplan } from '@/lib/floorplan';
import { decodeProject, PROJECT_KEY } from '@/lib/project-storage';
import PlanEditor from '@/components/plan-editor';
import { editorReducer, initialEditor, type EditCommand, type Tool } from '@/lib/building-editor';
import { initialMode, toolModeReducer } from '@/lib/tool-mode';
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
  const [mode, setMode] = useReducer(toolModeReducer, initialMode);
  const { tool } = mode;
  const buildOpen = mode.panel === 'build', furnitureOpen = mode.panel === 'furniture';
  const setTool = (tool: Tool) => { dispatch({ type: 'clear-error' }); setMode({ type: 'tool', tool }); };
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
  useEffect(() => {
    viewer.current?.cancelBuild();
    setCancelToken(n => n + 1);
    setSelectedWalls([]);
  }, [mode.revision]);

  useEffect(() => {
    if (!editor.error) return;
    setMode({ type: 'cancel' });
    const timer = window.setTimeout(() => dispatch({ type: 'clear-error' }), 3500);
    return () => window.clearTimeout(timer);
  }, [editor.error]);
  const [feedback, setFeedback] = useState('');
  useEffect(() => {
    if (!editor.past.length) return;
    setFeedback('Done');
    const timer = window.setTimeout(() => setFeedback(''), 1100);
    return () => window.clearTimeout(timer);
  }, [building, editor.past.length]);


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
      setMode({ type: 'cancel' });
    } catch (e) {
      if (id === generation.current) setError(e instanceof Error ? e.message : 'This floor plan could not be read.');
    } finally {
      if (id === generation.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(PROJECT_KEY);
      if (saved) {
        const project = decodeProject(saved);
        sourceRef.current = project.source;
        setSource(project.source);
        dispatch({ type: 'load', building: project.building });
        return;
      }
    } catch {
      setError('The saved project could not be restored. The sample plan has been opened.');
    }
    void generate('/sample-plan.svg');
    return () => { generation.current++; };
  }, [generate]);

  useEffect(() => {
    if (!building || source.startsWith('blob:')) return;
    try {
      localStorage.setItem(PROJECT_KEY, JSON.stringify({ version: 1, source, building }));
    } catch {
      setError('Your changes could not be saved in this browser. Keep this tab open to retain them.');
    }
  }, [building, source]);

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
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') { e.preventDefault(); viewer.current?.cancelBuild(); setCancelToken(n => n + 1); dispatch({ type: 'redo' }); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedWalls.length) { e.preventDefault(); dispatch({ type: 'edit', command: { type: 'delete-walls', wallIds: selectedWalls } }); return; }
      if (e.key === 'Escape') { setSelectedWalls([]); setMode({ type: 'cancel' });  setCancelToken(n => n + 1); viewer.current?.cancelBuild(); }
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
    let url: string;
    try {
      url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('The image could not be read.'));
        reader.readAsDataURL(file);
      });
    } catch {
      setError('The image could not be read. Try uploading it again.');
      return;
    }
    if (sourceRef.current.startsWith('blob:')) URL.revokeObjectURL(sourceRef.current);
    sourceRef.current = url;
    setSource(url);
    dispatch({ type: 'load', building: null });
    setTab('plan');
    await generate(url);
  };

  return (
    <main
      className={`workspace ${dragging ? 'dragging' : ''} ${editor.error ? 'placement-failed' : ''}`}
      data-tool={tool}
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
          {building ? <PlanEditor building={building} source={source} tool={tool} cancelToken={cancelToken} onEdit={commit} selectedWalls={selectedWalls} onSelectionChange={setSelectedWalls} /> : <div className="plan-image"><img src={source} alt="Source floor plan" /></div>}
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
          onClick={() => { viewer.current?.cancelBuild(); setTab('model'); setCancelToken(n => n + 1); }}
        >
          <Box size={17} /> 3D model
        </button>
        <button
          className={tab === 'plan' ? 'active' : ''}
          aria-current={tab === 'plan' ? 'page' : undefined}
          onClick={() => { viewer.current?.cancelBuild(); setTab('plan'); setCancelToken(n => n + 1); }}
        >
          <Grid2X2 size={17} /> Floor plan
        </button>
      </nav>

      {building && <>
        {<div hidden={!buildOpen} className="furniture-picker build-picker" aria-label="Build options">
          <button className={tool === 'select' ? 'active' : ''} onClick={() => { setMode({ type: 'cancel' }); }}><SquareDashed size={23}/><strong>Select</strong><span>Plan: drag wall endpoints</span></button>
          <button aria-pressed={tool === 'wall'} title="Select tool · Esc to cancel" className={tool === 'wall' ? 'active' : ''} onClick={() => { setTool('wall'); }}><BrickWall size={23}/><strong>Walls</strong><span>Draw one segment</span></button>
          <button aria-pressed={tool === 'floor'} title="Select tool · Esc to cancel" className={tool === 'floor' ? 'active' : ''} onClick={() => { setTool('floor'); }}><SquareDashed size={23}/><strong>Draw floor</strong><span>Choose two corners</span></button>
          <button aria-pressed={tool === 'fill-floor'} title="Select tool · Esc to cancel" className={tool === 'fill-floor' ? 'active' : ''} onClick={() => { setTool('fill-floor'); }}><PaintBucket size={23}/><strong>Fill room</strong><span>Click enclosed space</span></button>
        </div>}
        {<div hidden={!furnitureOpen} className="furniture-picker" aria-label="Doors and windows">
          <button aria-pressed={tool === 'door'} title="Select tool · Esc to cancel" className={tool === 'door' ? 'active' : ''} onClick={() => { setTool('door'); }}><DoorOpen size={23}/><strong>Door</strong><span>0.9 × 2.1 m</span></button>
          <button aria-pressed={tool === 'window'} title="Select tool · Esc to cancel" className={tool === 'window' ? 'active' : ''} onClick={() => { setTool('window'); }}><AppWindow size={23}/><strong>Window</strong><span>1.2 × 1.2 m</span></button>
        </div>}
        <div className={`build-instruction ${editor.past.length || editor.future.length || selectedWalls.length ? 'with-utilities' : ''}`} role="status">{tool === 'wall' ? 'Click start and end · Each wall finishes separately · Shift for angles · Esc to exit' : tool === 'floor' ? 'Click or drag between two corners to draw a floor · Esc to exit' : tool === 'fill-floor' ? 'Click inside an enclosed room to fill its floor · Esc to exit' : tool === 'door' || tool === 'window' ? `Click a wall to place a ${tool} · Esc to finish` : tool === 'delete' ? 'Click a wall, floor, door, or window to remove it · Esc to finish' : tab === 'model' ? 'Right-drag to orbit · Scroll to zoom · Shift-click or drag to select walls' : 'Choose a tool to edit your floor plan'}</div>
        <nav className="build-toolbar" aria-label="Building tools">
          <button aria-pressed={tool === 'wall' || tool === 'floor' || tool === 'fill-floor' || buildOpen} aria-expanded={buildOpen} className={tool === 'wall' || tool === 'floor' || tool === 'fill-floor' || buildOpen ? 'active' : ''} onClick={() => { setMode({ type: 'panel', panel: 'build' }); }}><BrickWall size={23}/><span>{tool === 'wall' ? 'Walls' : tool === 'floor' ? 'Draw floor' : tool === 'fill-floor' ? 'Fill room' : 'Build'}<small>Walls & floors</small></span></button>
          <button aria-pressed={tool === 'door' || tool === 'window' || furnitureOpen} aria-expanded={furnitureOpen} className={tool === 'door' || tool === 'window' || furnitureOpen ? 'active' : ''} onClick={() => { setMode({ type: 'panel', panel: 'furniture' }); }}><Armchair size={23}/><span>{tool === 'door' ? 'Door' : tool === 'window' ? 'Window' : 'Furniture'}<small>Doors & windows</small></span></button>
          <button title="Delete objects · Esc to cancel" aria-pressed={tool === 'delete'} className={tool === 'delete' ? 'active delete-active' : ''} onClick={() => { setTool(tool === 'delete' ? 'select' : 'delete');  }}><Trash2 size={22}/><span>Delete<small>Remove objects</small></span></button>
        </nav>
        {(editor.past.length > 0 || editor.future.length > 0 || selectedWalls.length > 0) && <div className="edit-utilities">
          {selectedWalls.length > 0 && <div className="selection-actions"><span>{selectedWalls.length} wall{selectedWalls.length === 1 ? '' : 's'} selected</span><button aria-label="Delete selected walls" title="Delete selected walls and all attachments" onClick={() => commit({ type: 'delete-walls', wallIds: selectedWalls })}><Trash2 size={15}/></button><button aria-label="Clear wall selection" onClick={() => setSelectedWalls([])}><X size={15}/></button></div>}
          {(editor.past.length > 0 || editor.future.length > 0) && <div className="history-buttons"><button aria-label="Undo" title="Undo (Ctrl/⌘ Z)" disabled={!editor.past.length} onClick={() => { viewer.current?.cancelBuild(); setCancelToken(n => n + 1); dispatch({ type: 'undo' }); }}><Undo2 size={16}/></button><button aria-label="Redo" title="Redo (Ctrl/⌘ Shift Z)" disabled={!editor.future.length} onClick={() => { viewer.current?.cancelBuild(); setCancelToken(n => n + 1); dispatch({ type: 'redo' }); }}><Redo2 size={16}/></button></div>}
        </div>}
      </>}

      {feedback && !editor.error && <div className="success-feedback" role="status">✓ {feedback}</div>}
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
