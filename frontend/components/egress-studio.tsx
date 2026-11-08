'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { AppWindow, ArrowDownToLine, ArrowLeft, ArrowRight, Check, ChevronLeft, ChevronRight, DoorOpen, FolderOpen, Hand, Layers3, Maximize, MousePointer2, Pause, Pencil, Play, Plus, Redo2, Save, Square, SquareDashed, Trash2, Undo2, Users, WandSparkles } from 'lucide-react';
import { createMockClient, createSpacetimeClient, type EgressClient, type PlaybackController } from '@egress/client';
import { useEgress } from '@egress/client/react';
import { deriveLayout, emptyDocument, parseDocument, type EditCommand, type EgressDocument, type WallMaterial } from '@egress/core';
import twoRooms from '../../content/scenes/two-rooms-corridor.json';
import { createLocalStudioClient } from '@/lib/studio-saves';
import type { SceneHandle, SceneTool } from './egress-scene';

const Scene = dynamic(() => import('./egress-scene'), { ssr: false, loading: () => <div className="studio-loading">Preparing the 3D workspace…</div> });
type Mode = 'design' | 'simulate' | 'analysis';
type Panel = 'build' | 'openings' | 'saves' | 'run';
const materials: { id: WallMaterial; name: string; note: string }[] = [{ id: 'normal', name: 'Normal', note: 'Standard interior wall' }, { id: 'reinforced', name: 'Reinforced', note: 'Thicker structural finish' }, { id: 'glass', name: 'Glass', note: 'Transparent partition' }];

function example(): EgressDocument {
  const doc = parseDocument(twoRooms);
  return { ...doc, walls: doc.walls.map((w, i) => ({ ...w, material: i === 3 ? 'glass' : i === 7 ? 'reinforced' : 'normal' })) };
}

export default function EgressStudio() {
  const [session, setSession] = useState<{ client: EgressClient; backend: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const backend = new URLSearchParams(location.search).get('backend') ?? 'browser';
    const client = backend === 'maincloud' ? createSpacetimeClient({ uri: 'wss://maincloud.spacetimedb.com', db: 'egress-dev' })
      : backend === 'local' ? createSpacetimeClient({ uri: 'ws://127.0.0.1:3010', db: 'egress-local' })
      : backend === 'mock' ? createMockClient({ seed: [{ name: 'Courtyard study', doc: example() }] })
      : createLocalStudioClient(localStorage, example(), setError);
    let disposed = false, initialized = false;
    const initialize = () => {
      if (initialized || client.status.get() !== 'connected') return;
      initialized = true;
      queueMicrotask(() => {
        if (disposed || client.document.get().doc) return;
        const projects = client.projects.get();
        void (projects.length ? client.openProject(projects[0].id) : client.createProject('Courtyard study', example())).catch(e => setError(String(e)));
      });
    };
    const unsubscribe = client.status.subscribe(initialize); initialize();
    queueMicrotask(() => { if (!disposed) setSession({ client, backend }); });
    return () => { disposed = true; unsubscribe(); client.dispose(); };
  }, []);
  if (!session) return <main className="studio-loading">Opening your workspace…</main>;
  return <Studio client={session.client} backend={session.backend} error={error} onError={setError} />;
}

function Studio({ client, backend, error, onError }: { client: EgressClient; backend: string; error: string; onError: (value: string) => void }) {
  const view = useEgress(client.document), projects = useEgress(client.projects), status = useEgress(client.status), runs = useEgress(client.runs);
  const [mode, setMode] = useState<Mode>('design'), [panel, setPanel] = useState<Panel>('build'), [menuOpen, setMenuOpen] = useState(true);
  const [tool, setTool] = useState<SceneTool>('select'), [material, setMaterial] = useState<WallMaterial>('normal'), [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState(''), [notice, setNotice] = useState(''), [people, setPeople] = useState(150), [runId, setRunId] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [analysisTab, setAnalysisTab] = useState<'report' | 'suggestions'>('report');
  const scene = useRef<SceneHandle>(null);
  const doc = view.doc, current = projects.find(p => p.id === view.projectId), wall = doc?.walls.find(w => w.id === selected);
  const derived = useMemo(() => doc ? deriveLayout(doc) : null, [doc]);
  const playback = useMemo(() => runId ? client.playback(runId) : null, [client, runId]);
  const latestRun = runs.find(r => r.id === runId), running = latestRun?.status === 'queued' || latestRun?.status === 'running';
  const perform = async (action: () => Promise<unknown>) => {
    onError(''); setBusy(true);
    try { await action(); } catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const edit = (commands: EditCommand[]) => { void perform(async () => { const result = await client.edit(commands); if (!result.ok) throw new Error(result.error.message); }); };
  const choose = (next: SceneTool, nextPanel?: Panel) => { setTool(next); setSelected(null); setMenuOpen(false); if (nextPanel) setPanel(nextPanel); };
  const switchMode = (next: Mode) => { setMode(next); setTool('select'); setSelected(null); setMenuOpen(false); setPanel(next === 'design' ? 'build' : next === 'simulate' ? 'run' : 'saves'); };
  const newSlot = () => { void perform(async () => { await client.createProject(name.trim() || `Untitled plan ${projects.length + 1}`, emptyDocument('new-plan')); setName(''); setSelected(null); setRunId(null); setMode('design'); setTool('box'); setPanel('build'); }); };
  const exportJson = () => {
    if (!doc) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `${current?.name ?? 'egress-plan'}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return;
      if (e.key === 'Escape') { setTool('select'); setSelected(null); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && mode === 'design') { e.preventDefault(); void (e.shiftKey ? client.redo() : client.undo()); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected && mode === 'design') { e.preventDefault(); void client.edit([{ kind: 'deleteEntities', ids: [selected] }]); setSelected(null); }
      if (e.key.toLowerCase() === 'f') scene.current?.preset('fit');
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [client, mode, selected]);
  const showPanel = (next: Panel) => { setPanel(next); setMenuOpen(true); };
  const save = () => { showPanel('saves'); setNotice(backend === 'browser' ? 'All changes are saved automatically on this device.' : backend === 'mock' ? 'This temporary preview is not persisted. Use local saves for storage.' : view.pending ? 'Waiting for the server to confirm your latest edit…' : 'Your latest changes are saved to the server.'); };
  const instructions = mode !== 'design' ? 'Drag to pan · Right-drag to orbit · Scroll to zoom'
    : tool === 'wall' ? 'Click two points, or drag · Shift for angles · 0.25 m snap'
    : tool === 'box' ? 'Drag between two corners to draw a room'
    : tool === 'erase' ? 'Click an object, or drag through walls to erase'
    : tool === 'door' || tool === 'window' || tool === 'exit' ? `Click a wall to place ${tool === 'exit' ? 'an exit' : `a ${tool}`}`
    : tool === 'pan' ? 'Drag to pan · Scroll to zoom · Editing stays top-down'
    : 'Select a wall to inspect it · Choose a tool below to start drawing';

  return <main className={`egress-studio ${menuOpen ? 'menu-open' : 'menu-closed'}`}>
    <header className="studio-header">
      <Link className="studio-brand" href="/" aria-label="Egress home"><Layers3 size={25} /><strong>egress<span>FLOW STUDIO</span></strong></Link>
      <nav className="studio-modes" aria-label="Workspace modes">{(['design', 'simulate', 'analysis'] as const).map((m, i) => <button key={m} className={mode === m ? 'active' : ''} aria-current={mode === m ? 'page' : undefined} onClick={() => switchMode(m)}><span>0{i + 1}</span>{m === 'design' ? 'Design' : m === 'simulate' ? 'Simulate' : 'Analysis'}</button>)}</nav>
      <div className="studio-status"><i className={status === 'connected' ? 'online' : ''} /><span>{backend === 'browser' ? 'LOCAL WORKSPACE' : backend === 'maincloud' ? 'MAINCLOUD' : backend === 'local' ? 'LOCAL SERVER' : 'TEMPORARY PREVIEW'}<small>{status === 'connected' ? view.pending ? 'Saving changes…' : 'All changes saved' : status}</small></span></div>
    </header>
    <div className="studio-body">
      <aside className={`studio-sidebar panel-${panel}`} aria-label="Workspace menu" aria-hidden={!menuOpen} inert={!menuOpen}>
        <div className="sidebar-heading"><span>WORKSPACE</span><button aria-label="Collapse left menu" onClick={() => setMenuOpen(false)}><ChevronLeft size={17} /></button></div>
        <h1>{current?.name ?? 'Your floor plan'}</h1><p className="sidebar-intro">Shape the space.<br />Understand the flow.</p>
        <div className="sidebar-actions"><button onClick={save} className={panel === 'saves' ? 'active' : ''}><Save size={17} />Save slots<span>{projects.length}</span></button><button onClick={exportJson} disabled={!doc}><ArrowDownToLine size={17} />Export plan</button></div>
        {panel === 'saves' ? <section className="sidebar-section"><span className="eyebrow">YOUR SAVES</span><p className="sidebar-description">{backend === 'browser' ? 'Stored in this browser. Your edits save as you go.' : 'Projects are saved through the connected backend.'}</p>
          <div className="save-slots">{projects.map(p => <button key={p.id} className={p.id === view.projectId ? 'active' : ''} onClick={() => { setSelected(null); setRunId(null); void perform(() => client.openProject(p.id)); }}><FolderOpen size={18} /><span>{p.name}<small>{p.id === view.projectId ? 'Current plan' : 'Open save'}</small></span>{p.id === view.projectId && <Check size={15} />}</button>)}</div>
          <label className="field-label">New plan name<input value={name} placeholder="Untitled plan" onChange={e => setName(e.target.value)} /></label><button className="primary-button" disabled={busy || status !== 'connected'} onClick={newSlot}><Plus size={16} />Create new</button>
          <div className="sidebar-divider" /><label className="field-label">Storage<select value={backend} onChange={e => { location.href = e.target.value === 'browser' ? '/' : `/?backend=${e.target.value}`; }}><option value="browser">Local save slots</option><option value="maincloud">Maincloud · egress-dev</option><option value="local">Local server</option><option value="mock">Temporary preview</option></select></label>
        </section> : mode === 'design' ? <section className="sidebar-section"><span className="eyebrow">{panel === 'openings' ? 'OPENINGS' : 'WALL LIBRARY'}</span>
          {panel === 'openings' ? <>{([{ id: 'door', title: 'Door', detail: '0.9 m · open leaf', icon: DoorOpen }, { id: 'exit', title: 'Exit', detail: '1.2 m · evacuation route', icon: ArrowRight }, { id: 'window', title: 'Window', detail: '1.2 m · glazed opening', icon: AppWindow }] as const).map(item => <button className={`asset-card ${tool === item.id ? 'active' : ''}`} key={item.id} onClick={() => choose(item.id, 'openings')}><div className={`asset-preview preview-${item.id}`}><item.icon size={30} /></div><span><strong>{item.title}</strong><small>{item.detail}</small></span><Plus size={15} /></button>)}</>
          : <>{materials.map(m => <button key={m.id} className={`asset-card ${material === m.id ? 'active' : ''}`} onClick={() => { setMaterial(m.id); choose('wall', 'build'); }}><div className={`asset-preview preview-${m.id}`}><i /><i /><i /></div><span><strong>{m.name}</strong><small>{m.note}</small></span>{material === m.id ? <Check size={15} /> : <Plus size={15} />}</button>)}<p className="sidebar-description">Draw a wall or a complete room. Doors, exits and windows attach to your walls.</p></>}
          {wall && <div className="selection-inspector"><span className="eyebrow">SELECTED WALL</span><label className="field-label">Wall type<select value={wall.material} onChange={e => edit([{ kind: 'updateWall', wallId: wall.id, patch: { material: e.target.value as WallMaterial } }])}>{materials.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label><button onClick={() => { edit([{ kind: 'deleteEntities', ids: [wall.id] }]); setSelected(null); }}><Trash2 size={15} />Delete wall</button></div>}
        </section> : <section className="sidebar-section"><span className="eyebrow">PEOPLE FLOW</span><h2>A space under pressure.</h2><p className="sidebar-description">Run an exploratory evacuation with the existing pedestrian model.</p><label className="field-label">Population<input type="number" min={1} max={1000} value={people} disabled={running} onChange={e => setPeople(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))} /></label><p className="sidebar-description">Place an exit on an exterior wall before running. All three wall materials block pedestrians.</p>{derived?.diagnostics.map((d, i) => <p className="diagnostic" key={i}>{d.message}</p>)}</section>}
        <div className="sidebar-footer"><span>GROUND FLOOR</span><small>{doc?.walls.length ?? 0} walls · {doc?.openings.length ?? 0} openings · {derived?.topology.rooms.length ?? 0} rooms</small></div>
      </aside>
      <section className="studio-viewport" aria-label="Building workspace">
        <Scene ref={scene} doc={doc} editing={mode === 'design'} tool={tool} material={material} selected={selected} onSelect={id => { setSelected(id); if (id) showPanel('build'); }} onEdit={edit} playback={playback} />
        <button className="menu-handle" aria-label={menuOpen ? 'Collapse left menu' : 'Open left menu'} aria-expanded={menuOpen} onClick={() => setMenuOpen(v => !v)}>{menuOpen ? <ChevronLeft size={15} /> : <ChevronRight size={15} />}</button>
        <div className="viewport-title"><span>{mode === 'design' ? 'DESIGN WORKSPACE' : mode === 'simulate' ? 'SIMULATION WORKSPACE' : 'ANALYSIS WORKSPACE'}</span><strong>{mode === 'design' ? 'A clearer path starts here.' : mode === 'simulate' ? 'See how your space moves.' : 'Make room for better flow.'}</strong></div>
        <div className="viewport-tools"><button aria-label="Frame building" title="Frame building (F)" onClick={() => scene.current?.preset('fit')}><Maximize size={17} /></button><button aria-label="Export workspace image" title="Export workspace image" onClick={() => scene.current?.exportImage()}><ArrowDownToLine size={17} /></button></div>
        {mode === 'analysis' && <Analysis client={client} playback={playback} tab={analysisTab} onError={onError} />}
        <div className="studio-bottom"><p className="tool-hint">{instructions}</p>
          <nav className="studio-dock" aria-label="Mode tools" onClickCapture={() => setMenuOpen(false)}>{mode === 'design' ? <>
            <button aria-label="Select walls" className={tool === 'select' ? 'active' : ''} onClick={() => choose('select')}><MousePointer2 size={19} /><span>Select<small>Inspect walls</small></span></button>
            <button aria-label="Draw walls" className={tool === 'wall' ? 'active' : ''} onClick={() => choose('wall', 'build')}><Pencil size={20} /><span>Walls<small>{material}</small></span></button>
            <button aria-label="Draw room" className={tool === 'box' ? 'active' : ''} onClick={() => choose('box', 'build')}><SquareDashed size={21} /><span>Room<small>Drag a box</small></span></button>
            <button aria-label="Opening tools" className={['door', 'window', 'exit'].includes(tool) ? 'active' : ''} onClick={() => { setPanel('openings'); setTool('door'); setMenuOpen(false); }}><DoorOpen size={21} /><span>Openings<small>Door · Exit · Window</small></span></button>
            <button aria-label="Erase objects" className={tool === 'erase' ? 'active danger' : ''} onClick={() => choose('erase')}><Trash2 size={20} /><span>Erase<small>Click or drag</small></span></button>
            <div className="dock-divider" /><button className="icon-only" aria-label="Undo" disabled={!view.canUndo} onClick={() => { setMenuOpen(false); void perform(() => client.undo()); }}><Undo2 size={18} /></button><button className="icon-only" aria-label="Redo" disabled={!view.canRedo} onClick={() => { setMenuOpen(false); void perform(() => client.redo()); }}><Redo2 size={18} /></button>
          </> : mode === 'simulate' ? <>
            <button onClick={() => { setMenuOpen(false); void perform(async () => {
              if (running && runId) { await client.cancelRun(runId); return; }
              if (!doc) return;
              const id = await client.startRun({ scenarioVersion: 1, id: `s-${crypto.randomUUID()}`, projectId: doc.projectId, name: 'Evacuate', durationSeconds: 300, population: { count: people, distribution: 'uniform', strokes: [], seed: 1 }, goal: { kind: 'evacuate', blockedExitIds: [] } }, 'x4');
              const nextPlayback = client.playback(id); nextPlayback.setSpeed(4); nextPlayback.play(); setRunId(id);
            }); }} disabled={!doc || busy} className="run-action">{running ? <Square size={18} /> : <Play size={20} />}<span>{running ? 'Stop run' : 'Run evacuation'}<small>{people} people · 4× pace</small></span></button>
            <button onClick={() => setPanel('run')}><Users size={20} /><span>Population<small>Configure run</small></span></button><button disabled={!playback} onClick={() => playback?.skip(-10)} aria-label="Back 10 seconds"><ArrowLeft size={18} />10s</button><PlaybackToggle playback={playback} /><button disabled={!playback} onClick={() => playback?.skip(10)} aria-label="Forward 10 seconds">10s<ArrowRight size={18} /></button>
          </> : <><button className={analysisTab === 'report' ? 'active' : ''} onClick={() => { setAnalysisTab('report'); setMenuOpen(false); }}><Layers3 size={20} /><span>Report<small>Measured results</small></span></button><button className={analysisTab === 'suggestions' ? 'active' : ''} onClick={() => { setAnalysisTab('suggestions'); setMenuOpen(false); }}><WandSparkles size={20} /><span>Suggestions<small>Test a change</small></span></button></>}</nav>
        </div>
        <button className={`pan-handle ${tool === 'pan' ? 'active' : ''}`} aria-label="Pan workspace" aria-pressed={tool === 'pan'} onClick={() => choose(tool === 'pan' ? 'select' : 'pan')}><Hand size={23} /></button>
        <div className="viewport-scale">0.25 m SNAP<span />GROUND / 01</div>
        {(error || view.lastError) && <div className="studio-message error" role="alert"><span>{error || view.lastError?.message}</span><button aria-label="Dismiss error" onClick={() => onError('')}>×</button></div>}
        {notice && !error && <div className="studio-message" role="status"><Check size={15} /><span>{notice}</span><button aria-label="Dismiss save status" onClick={() => setNotice('')}>×</button></div>}
      </section>
    </div>
  </main>;
}

function PlaybackToggle({ playback }: { playback: PlaybackController | null }) {
  if (!playback) return <button disabled aria-label="Pause playback"><Pause size={18} /></button>;
  return <ConnectedPlaybackToggle playback={playback} />;
}
function ConnectedPlaybackToggle({ playback }: { playback: PlaybackController }) {
  const state = useEgress(playback.state);
  return <button aria-label={state.playing ? 'Pause playback' : 'Play playback'} onClick={() => playback.toggle()}>{state.playing ? <Pause size={18} /> : <Play size={18} />}</button>;
}
function Analysis({ client, playback, tab, onError }: { client: EgressClient; playback: PlaybackController | null; tab: 'report' | 'suggestions'; onError: (text: string) => void }) {
  const jobs = useEgress(client.agentJobs), proposals = useEgress(client.proposals);
  const [prompt, setPrompt] = useState('Investigate the worst bottleneck and suggest a measured improvement.');
  const working = jobs.some(j => j.status === 'queued' || j.status === 'running');
  return <aside className="analysis-panel" aria-label="Analysis results"><span className="eyebrow">{tab === 'report' ? 'RUN REPORT' : 'DESIGN SUGGESTIONS'}</span><h2>{tab === 'report' ? 'Follow the evidence.' : 'A better way through.'}</h2>
    {tab === 'report' ? playback ? <RunMetrics playback={playback} /> : <p>Run an evacuation in Simulate to see measured results here. You can explore the building freely while you review.</p> : <>{proposals.length ? proposals.map(p => <article className="proposal-card" key={p.id}><strong>{p.notes.summary}</strong><p>{p.delta.evacuationTimeSeconds !== undefined ? `${p.delta.evacuationTimeSeconds > 0 ? '+' : ''}${p.delta.evacuationTimeSeconds} s modeled evacuation change` : 'Measured candidate'}</p><div><button disabled={p.status !== 'proposed'} onClick={() => void client.acceptProposal(p.id).catch(e => onError(String(e)))}>{p.status === 'accepted' ? 'Accepted' : 'Accept change'}</button><button disabled={p.status !== 'proposed'} onClick={() => void client.rejectProposal(p.id).catch(e => onError(String(e)))}>Reject</button></div></article>) : <p>Ask the agent to test changes against the same people and seed. Only you can apply a proposed edit.</p>}
      {jobs.map(j => <div className="agent-message" key={j.id}><strong>{j.status === 'running' || j.status === 'queued' ? 'Investigating…' : 'Agent'}</strong><p>{j.summary || j.prompt}</p></div>)}
      <form onSubmit={e => { e.preventDefault(); if (prompt.trim()) void client.askAgent(prompt, playback ? { runId: playback.state.get().runId } : undefined).catch(e => onError(String(e))); }}><label htmlFor="studio-agent">Ask about your layout</label><textarea id="studio-agent" value={prompt} onChange={e => setPrompt(e.target.value)} rows={3} /><button className="primary-button" disabled={working || !prompt.trim()}><WandSparkles size={15} />{working ? 'Testing changes…' : 'Investigate layout'}</button></form></>}
    <small className="model-disclaimer">Exploratory modeling · not a safety certification</small>
  </aside>;
}
function RunMetrics({ playback }: { playback: PlaybackController }) {
  const metrics = useEgress(playback.metrics), state = useEgress(playback.state);
  return <><div className="report-number">{metrics?.evacuationTimeSeconds ?? Math.round(state.tick / 10)}<span>seconds {metrics?.evacuationTimeSeconds ? 'to evacuate' : 'simulated'}</span></div><dl className="report-metrics"><div><dt>Evacuated</dt><dd>{metrics?.evacuatedPeople ?? '—'}</dd></div><div><dt>Remaining</dt><dd>{metrics?.remainingPeople ?? '—'}</dd></div><div><dt>Maximum queue</dt><dd>{metrics?.maxQueueLength ?? '—'}</dd></div></dl></>;
}
