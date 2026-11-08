'use client';
/**
 * Egress studio (Plan.md §8 "UI direction v2"): a full-window scene with a
 * compact mode switch, a left pull-tab rail for meta actions, an optional right
 * context pane and a bottom context toolbar. Projects live only on the server
 * (D58); the browser keeps just the SpacetimeDB token.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import {
  ArrowDownTrayIcon, ArrowPathIcon, ArrowRightEndOnRectangleIcon, ArrowRightStartOnRectangleIcon, ArrowUpTrayIcon, ArrowUturnLeftIcon,
  ArrowUturnRightIcon, ArrowsPointingOutIcon, BackspaceIcon, BackwardIcon, CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon,
  CursorArrowRaysIcon, FolderIcon, ForwardIcon, LinkIcon, PaperAirplaneIcon, PauseIcon, PencilIcon, PlayIcon, PlusIcon, ShareIcon, SignalSlashIcon,
  SparklesIcon, Square3Stack3DIcon, StopIcon, TrashIcon, WindowIcon, XMarkIcon,
} from '@heroicons/react/24/outline';
import { createMockClient, createSpacetimeClient, type AgentStep, type EgressClient, type PlaybackController, type ProposalView, type RunComparison } from '@egress/client';
import { useEgress } from '@egress/client/react';
import { parseDocument, type EditCommand, type EgressDocument, type Opening, type SimulationMetrics, type Wall, type WallMaterial } from '@egress/core';
import twoRooms from '../../content/scenes/two-rooms-corridor.json';
import type { HeatOverlay, SceneHandle, SceneLayer, SceneNote, SceneTool } from './egress-scene';
import SketchImporter from './sketch-importer';
import { buildingToDocument } from '@/lib/import-building';

const Scene = dynamic(() => import('./egress-scene'), { ssr: false, loading: () => <div className="scene-loading" /> });

type Mode = 'edit' | 'simulate' | 'analysis';
type Modal = 'projects' | 'share' | 'import' | null;
type Menu = { x: number; y: number; wallId: string | null; openingId: string | null } | null;

const WALL_TYPES: { id: WallMaterial; name: string }[] = [{ id: 'normal', name: 'Normal' }, { id: 'reinforced', name: 'Reinforced' }, { id: 'glass', name: 'Glass' }];
const MODES: { id: Mode; name: string; key: string }[] = [{ id: 'edit', name: 'Edit', key: '1' }, { id: 'simulate', name: 'Simulate', key: '2' }, { id: 'analysis', name: 'Analysis', key: '3' }];
const STEP_LABEL: Record<string, string> = {
  inspect_layout: 'Read layout', inspect_run: 'Read run', run_scenario: 'Baseline simulation', get_hotspots: 'Find bottlenecks',
  test_edit_batch: 'Test change', confirm_candidate: 'Re-test on new crowds', compare_runs: 'Compare runs', submit_proposal: 'Propose change',
};

function example(): EgressDocument {
  const doc = parseDocument(twoRooms);
  return { ...doc, walls: doc.walls.map((w, i) => ({ ...w, material: i === 3 ? 'glass' : i === 7 ? 'reinforced' : 'normal' })) };
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
const signed = (v: number, unit = '') => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(1)}${unit}`;
const firstSentence = (text: string) => { const s = text.split(/(?<=\.)\s/)[0] ?? text; return s.length > 120 ? `${s.slice(0, 117)}…` : s; };

// ── Boot: pick the backend, then the project ────────────────────────────────

export default function EgressStudio() {
  const [session, setSession] = useState<{ client: EgressClient; backend: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    // Default: the server named in the repo .env (inlined by next.config.ts), else Maincloud egress-dev.
    const backend = params.get('backend') ?? 'server';
    const client = backend === 'local'
      ? createSpacetimeClient({ uri: params.get('uri') ?? 'ws://127.0.0.1:3010', db: params.get('db') ?? 'egress-local' })
      : backend === 'mock' // in-memory, development only; nothing is stored
        ? createMockClient({ seed: [{ name: 'Courtyard study', doc: example() }] })
        : backend === 'maincloud'
          ? createSpacetimeClient({ uri: 'wss://maincloud.spacetimedb.com', db: 'egress-dev' })
          : createSpacetimeClient({ uri: process.env.EGRESS_SPACETIME_URI || 'wss://maincloud.spacetimedb.com', db: process.env.EGRESS_SPACETIME_DB || 'egress-dev' });
    let disposed = false, started = false;
    const start = () => {
      if (started || client.status.get() !== 'connected') return;
      started = true;
      queueMicrotask(async () => {
        if (disposed) return;
        try {
          const join = params.get('join'), wanted = params.get('project');
          if (join) { await client.joinProject(join); return; }
          const projects = [...client.projects.get()].sort((a, b) => b.updatedAt - a.updatedAt);
          if (wanted && projects.some(p => p.id === wanted)) await client.openProject(wanted);
          else if (projects.length) await client.openProject(projects[0].id);
          else await client.createProject('Untitled plan', example());
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      });
    };
    const unsubscribe = client.status.subscribe(start); start();
    queueMicrotask(() => { if (!disposed) setSession({ client, backend }); });
    return () => { disposed = true; unsubscribe(); client.dispose(); };
  }, []);
  if (!session) return <main className="studio" />;
  return <Studio client={session.client} backend={session.backend} bootError={error} />;
}

// ── Studio ──────────────────────────────────────────────────────────────────

function Studio({ client, backend, bootError }: { client: EgressClient; backend: string; bootError: string }) {
  const view = useEgress(client.document), projects = useEgress(client.projects), status = useEgress(client.status);
  const runs = useEgress(client.runs), runner = useEgress(client.runner), proposals = useEgress(client.proposals), jobs = useEgress(client.agentJobs);
  const [mode, setMode] = useState<Mode>('edit');
  const [tool, setTool] = useState<SceneTool>('select');
  const [wallType, setWallType] = useState<WallMaterial>('normal');
  const [selected, setSelected] = useState<string | null>(null);
  const [rail, setRail] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [typeMenu, setTypeMenu] = useState<{ x: number; y: number } | null>(null);
  const [layersOpen, setLayersOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [layer, setLayer] = useState<SceneLayer>({ people: 'discrete', field: 'people.density', stat: 'instant' });
  const [runId, setRunId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [diffMap, setDiffMap] = useState(false);
  const [error, setError] = useState(bootError);
  const scene = useRef<SceneHandle>(null);

  const doc = view.doc;
  const project = projects.find(p => p.id === view.projectId);
  const role = project?.role ?? 'viewer';
  const canEdit = role !== 'viewer';
  const userRuns = runs.filter(r => !r.agentJobId);
  const activeRunId = runId && runs.some(r => r.id === runId) ? runId : userRuns[0]?.id ?? null;
  const playback = useMemo(() => (activeRunId ? client.playback(activeRunId) : null), [client, activeRunId]);
  const activeRun = runs.find(r => r.id === activeRunId);
  const running = activeRun?.status === 'queued' || activeRun?.status === 'running';

  // Keep the URL pointing at the open project so it can be shared or reloaded.
  useEffect(() => {
    if (!view.projectId) return;
    const url = new URL(location.href);
    url.searchParams.delete('join');
    if (url.searchParams.get('project') !== view.projectId) { url.searchParams.set('project', view.projectId); history.replaceState(null, '', url); }
  }, [view.projectId]);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const edit = (commands: EditCommand[]) => {
    if (!canEdit) { setError('You have view access to this project.'); return; }
    void client.edit(commands).then(r => { if (!r.ok) setError(r.error.message); }).catch(fail);
  };
  const switchMode = (next: Mode) => { setMode(next); setTool('select'); setSelected(null); setMenu(null); setTypeMenu(null); };
  const choose = (next: SceneTool) => { setTool(next); setSelected(null); setMenu(null); setTypeMenu(null); };

  // Analysis: preview the newest open proposal on the model.
  const openProposals = proposals.filter(p => p.status === 'proposed');
  const preview = mode === 'analysis' ? proposals.find(p => p.id === previewId) ?? openProposals[0] ?? null : null;
  const ghost = preview?.status === 'proposed' ? preview.ghost : null;
  const highlight = useMemo(() => new Set(ghost ? [...ghost.createdIds.flat(), ...ghost.changedIds] : []), [ghost]);
  const notes = useMemo<SceneNote[]>(() => {
    if (!preview || !ghost) return [];
    return preview.commands.flatMap((c, i) => {
      const text = preview.notes.byCommand[String(i)];
      const created = ghost.createdIds[i] ?? [];
      const entityId = ('openingId' in c && c.openingId) || ('wallId' in c && c.kind !== 'createOpening' && c.wallId)
        || created.find(id => ghost.doc.openings.some(o => o.id === id)) || created.find(id => ghost.doc.walls.some(w => w.id === id));
      return text && entityId ? [{ key: `${preview.id}:${i}`, text: firstSentence(text), entityId }] : [];
    });
  }, [preview, ghost]);
  const [comparison, setComparison] = useState<RunComparison | null>(null);
  useEffect(() => {
    let live = true;
    if (!preview) { queueMicrotask(() => { if (live) setComparison(null); }); return () => { live = false; }; }
    client.compareRuns(preview.baselineRunId, preview.candidateRunId).then(c => { if (live) setComparison(c); }).catch(() => { if (live) setComparison(null); });
    return () => { live = false; };
  }, [client, preview?.id, preview?.baselineRunId, preview?.candidateRunId]); // eslint-disable-line react-hooks/exhaustive-deps
  const overlay: HeatOverlay | null = mode === 'analysis' && diffMap && comparison?.congestionDiff ? { field: comparison.congestionDiff, diverging: true } : null;

  // Keyboard: tools, history, modes.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select, dialog')) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) {
        if (mode !== 'edit') return;
        e.preventDefault(); void ((k === 'y' || e.shiftKey) ? client.redo() : client.undo()).catch(fail); return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') { setTool('select'); setSelected(null); setMenu(null); setTypeMenu(null); setLayersOpen(false); setExportOpen(false); return; }
      const m = MODES.find(x => x.key === e.key); if (m) { switchMode(m.id); return; }
      if (k === 'f') { scene.current?.view('fit'); return; }
      if (mode === 'edit') {
        const tools: Record<string, SceneTool> = { v: 'select', w: 'wall', r: 'box', d: 'door', n: 'window', e: 'exit', x: 'erase' };
        if (tools[k] && (canEdit || k === 'v')) { choose(tools[k]); return; }
        if ((e.key === 'Delete' || e.key === 'Backspace') && selected && canEdit) { e.preventDefault(); edit([{ kind: 'deleteEntities', ids: [selected] }]); setSelected(null); }
      }
      if (mode === 'simulate' && playback) {
        if (e.code === 'Space') { e.preventDefault(); playback.toggle(); }
        if (e.key === 'ArrowLeft') playback.skip(-10);
        if (e.key === 'ArrowRight') playback.skip(10);
      }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  });

  const startRun = (people: number, seed: number) => {
    if (!doc) return;
    setError('');
    void client.startRun({ scenarioVersion: 1, id: `s-${crypto.randomUUID()}`, projectId: doc.projectId, name: 'Evacuate', durationSeconds: 900, population: { count: people, distribution: 'uniform', strokes: [], seed }, goal: { kind: 'evacuate', blockedExitIds: [] } }, 'x4')
      .then(id => { setRunId(id); const p = client.playback(id); p.setSpeed(speedRef.current); p.play(); })
      .catch(fail);
  };
  const speedRef = useRef(1);

  const exportJson = () => {
    if (!doc) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `${project?.name ?? 'egress-plan'}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const sceneDoc = ghost?.doc ?? doc;
  const wall = doc?.walls.find(w => w.id === selected) ?? null;
  const opening = doc?.openings.find(o => o.id === selected) ?? null;
  const showPane = mode === 'simulate' || (mode === 'edit' && (wall || opening)) || (mode === 'analysis' && (proposals.length > 0 || jobs.length > 0));
  const saving = view.pending > 0;

  return <main className={`studio mode-${mode}`} onContextMenu={e => e.preventDefault()}>
    <Scene ref={scene} doc={sceneDoc} editing={mode === 'edit'} tool={canEdit ? tool : 'select'} wallType={wallType} selected={selected}
      highlight={highlight} notes={notes} playback={mode === 'edit' ? null : playback} layer={layer} overlay={overlay}
      onSelect={setSelected} onEdit={edit}
      onContext={(at, hit) => { setTypeMenu(null); setMenu(hit && canEdit ? { ...at, wallId: hit.wallId ?? null, openingId: hit.openingId ?? null } : null); if (hit) setSelected(hit.openingId ?? hit.wallId ?? null); }} />

    {/* Top left: project + sync state */}
    <button className="project-chip" onClick={() => setModal('projects')} data-tip="Projects">
      <i className={`sync ${status !== 'connected' ? 'off' : saving ? 'busy' : 'ok'}`} />
      <span>{project?.name ?? (status === 'connected' ? 'Untitled plan' : 'Connecting…')}</span>
      {role !== 'owner' && project && <em>{role}</em>}
      <ChevronDownIcon />
    </button>

    {/* Top center: modes */}
    <nav className="mode-switch" aria-label="Mode">
      {MODES.map(m => <button key={m.id} aria-pressed={mode === m.id} onClick={() => switchMode(m.id)} data-tip={`${m.name} (${m.key})`}>{m.name}</button>)}
    </nav>

    {/* Top right: server state, layers */}
    <div className="hud-right">
      {!runner.online && backend !== 'mock' && <span className="chip warn" data-tip="Runs and the agent wait until the simulation server is back"><SignalSlashIcon />Sim server offline</span>}
      <button className={`hud-button ${layersOpen ? 'on' : ''}`} onClick={() => { setLayersOpen(v => !v); setExportOpen(false); }} aria-expanded={layersOpen}><Square3Stack3DIcon />Layers<ChevronDownIcon className="caret" /></button>
      {layersOpen && <LayersMenu layer={layer} onChange={setLayer} onClose={() => setLayersOpen(false)} />}
    </div>

    {/* Left: pull tab → meta rail */}
    {rail ? <nav className="rail" aria-label="Project">
      <RailButton tip="Projects" onClick={() => setModal('projects')}><FolderIcon /></RailButton>
      <RailButton tip="Share" onClick={() => setModal('share')}><ShareIcon /></RailButton>
      <RailButton tip="Import plan image" onClick={() => setModal('import')}><ArrowUpTrayIcon /></RailButton>
      <div className="rail-anchor">
        <RailButton tip="Export" onClick={() => setExportOpen(v => !v)}><ArrowDownTrayIcon /></RailButton>
        {exportOpen && <div className="menu rail-menu" onMouseLeave={() => setExportOpen(false)}>
          <button disabled={!doc} onClick={() => { exportJson(); setExportOpen(false); }}>Plan (.json)</button>
          <button onClick={() => { scene.current?.exportImage(); setExportOpen(false); }}>Image (.png)</button>
        </div>}
      </div>
      <RailButton tip="Frame model (F)" onClick={() => scene.current?.view('fit')}><ArrowsPointingOutIcon /></RailButton>
      <span className="rail-sep" />
      <RailButton tip="Collapse" onClick={() => { setRail(false); setExportOpen(false); }}><ChevronLeftIcon /></RailButton>
    </nav> : <button className="rail-tab" aria-label="Open project menu" onClick={() => setRail(true)}><ChevronRightIcon /></button>}

    {/* Right: context pane */}
    {showPane && <aside className="pane" aria-label="Details">
      {mode === 'edit' && wall && <WallInspector wall={wall} canEdit={canEdit} onEdit={edit} onDelete={() => { edit([{ kind: 'deleteEntities', ids: [wall.id] }]); setSelected(null); }} doc={doc!} />}
      {mode === 'edit' && opening && <OpeningInspector opening={opening} canEdit={canEdit} onEdit={edit} onDelete={() => { edit([{ kind: 'deleteEntities', ids: [opening.id] }]); setSelected(null); }} />}
      {mode === 'simulate' && <SimulatePane client={client} playback={playback} running={running} runFailed={activeRun?.status === 'failed' ? activeRun.error?.message ?? 'Run failed' : null} runnerOnline={runner.online || backend === 'mock'} onRun={startRun} onStop={() => { if (activeRunId) void client.cancelRun(activeRunId).catch(fail); }} hasDoc={!!doc} />}
      {mode === 'analysis' && <AnalysisPane client={client} preview={preview} comparison={comparison} diffMap={diffMap} onDiffMap={setDiffMap} onPreview={setPreviewId} canEdit={canEdit} onError={fail} />}
    </aside>}

    {/* Bottom: context toolbar */}
    <footer className="dock" aria-label={`${mode} tools`}>
      {mode === 'edit' && <>
        <Tool tip="Select (V)" on={tool === 'select'} onClick={() => choose('select')}><CursorArrowRaysIcon /></Tool>
        <Tool tip={`Wall · ${WALL_TYPES.find(t => t.id === wallType)!.name} (W) · right-click for type`} on={tool === 'wall'} disabled={!canEdit} onClick={() => choose('wall')}
          onContextMenu={e => { e.preventDefault(); if (!canEdit) return; const r = e.currentTarget.getBoundingClientRect(); setMenu(null); setTypeMenu({ x: r.left + r.width / 2, y: r.top }); }}>
          <PencilIcon /><i className={`swatch ${wallType}`} />
        </Tool>
        <Tool tip="Room (R)" on={tool === 'box'} disabled={!canEdit} onClick={() => choose('box')}><StopIcon /></Tool>
        <span className="sep" />
        <Tool tip="Door (D)" on={tool === 'door'} disabled={!canEdit} onClick={() => choose('door')}><ArrowRightEndOnRectangleIcon /></Tool>
        <Tool tip="Window (N)" on={tool === 'window'} disabled={!canEdit} onClick={() => choose('window')}><WindowIcon /></Tool>
        <Tool tip="Exit (E)" on={tool === 'exit'} disabled={!canEdit} onClick={() => choose('exit')}><ArrowRightStartOnRectangleIcon /></Tool>
        <span className="sep" />
        <Tool tip="Erase (X) · click or drag across walls" on={tool === 'erase'} disabled={!canEdit} onClick={() => choose('erase')}><BackspaceIcon /></Tool>
        <span className="sep" />
        <Tool tip="Undo (Ctrl+Z)" disabled={!view.canUndo || !canEdit} onClick={() => void client.undo().catch(fail)}><ArrowUturnLeftIcon /></Tool>
        <Tool tip="Redo (Ctrl+Shift+Z)" disabled={!view.canRedo || !canEdit} onClick={() => void client.redo().catch(fail)}><ArrowUturnRightIcon /></Tool>
      </>}
      {mode === 'simulate' && <Transport playback={playback} running={running} onSpeed={s => { speedRef.current = s; }} />}
      {mode === 'analysis' && <ChatBar client={client} playback={playback} onError={fail} disabled={!doc} />}
    </footer>

    {typeMenu && <div className="menu type-menu" style={{ left: typeMenu.x, top: typeMenu.y }} onMouseLeave={() => setTypeMenu(null)}>
      {WALL_TYPES.map(t => <button key={t.id} aria-pressed={wallType === t.id} onClick={() => { setWallType(t.id); setTool('wall'); setTypeMenu(null); }}><i className={`swatch ${t.id}`} />{t.name}{wallType === t.id && <CheckIcon />}</button>)}
    </div>}
    {menu && <div className="menu context-menu" style={{ left: menu.x, top: menu.y }} onMouseLeave={() => setMenu(null)}>
      {menu.wallId && !menu.openingId && WALL_TYPES.map(t => <button key={t.id} onClick={() => { edit([{ kind: 'updateWall', wallId: menu.wallId!, patch: { material: t.id } }]); setMenu(null); }}>
        <i className={`swatch ${t.id}`} />{t.name}{doc?.walls.find(w => w.id === menu.wallId)?.material === t.id && <CheckIcon />}</button>)}
      {menu.wallId && !menu.openingId && <hr />}
      <button className="danger" onClick={() => { edit([{ kind: 'deleteEntities', ids: [menu.openingId ?? menu.wallId!] }]); setSelected(null); setMenu(null); }}><TrashIcon />Delete</button>
    </div>}

    {(error || view.lastError) && <div className="toast" role="alert"><span>{error || view.lastError?.message}</span><button aria-label="Dismiss" onClick={() => setError('')}><XMarkIcon /></button></div>}

    {modal === 'projects' && <ProjectsModal client={client} onClose={() => setModal(null)} onOpened={() => { setSelected(null); setRunId(null); setPreviewId(null); setModal(null); switchMode('edit'); }} onError={fail} />}
    {modal === 'share' && <ShareModal client={client} role={role} backend={backend} onClose={() => setModal(null)} />}
    {modal === 'import' && <div className="modal-backdrop" role="dialog" aria-modal="true"><div className="modal import-host">
      <SketchImporter current={null} onClose={() => setModal(null)} onImport={building => {
        const name = `Imported plan ${new Date().toLocaleDateString()}`;
        void client.createProject(name, buildingToDocument(building)).then(() => { setSelected(null); setRunId(null); switchMode('edit'); }).catch(fail);
      }} />
    </div></div>}
  </main>;
}

// ── Small pieces ────────────────────────────────────────────────────────────

function Tool({ tip, on, disabled, onClick, onContextMenu, children }: { tip: string; on?: boolean; disabled?: boolean; onClick(): void; onContextMenu?: React.MouseEventHandler<HTMLButtonElement>; children: ReactNode }) {
  return <button className="tool" aria-pressed={on} aria-label={tip} data-tip={tip} disabled={disabled} onClick={onClick} onContextMenu={onContextMenu}>{children}</button>;
}

function RailButton({ tip, onClick, children }: { tip: string; onClick(): void; children: ReactNode }) {
  return <button className="rail-button" aria-label={tip} data-tip={tip} data-tip-side="right" onClick={onClick}>{children}</button>;
}

function Segmented<T extends string>({ value, options, onChange, disabled }: { value: T; options: { id: T; name: string; disabled?: boolean }[]; onChange(v: T): void; disabled?: boolean }) {
  return <div className="segmented">{options.map(o => <button key={o.id} aria-pressed={value === o.id} disabled={disabled || o.disabled} onClick={() => onChange(o.id)}>{o.name}</button>)}</div>;
}

function LayersMenu({ layer, onChange, onClose }: { layer: SceneLayer; onChange(l: SceneLayer): void; onClose(): void }) {
  return <div className="menu layers-menu" onMouseLeave={onClose}>
    <div className="menu-label">Layer</div>
    <button aria-pressed><CheckIcon />People</button>
    <button disabled>Airflow</button>
    <hr />
    <div className="menu-label">View</div>
    <Segmented value={layer.people} options={[{ id: 'discrete', name: 'Discrete' }, { id: 'heatmap', name: 'Heatmap' }]} onChange={people => onChange({ ...layer, people })} />
    {layer.people === 'heatmap' && <>
      <div className="menu-label">Field</div>
      <Segmented value={layer.field} options={[{ id: 'people.density', name: 'Density' }, { id: 'people.congestion', name: 'Congestion' }]} onChange={field => onChange({ ...layer, field })} />
      <div className="menu-label">Statistic</div>
      <Segmented value={layer.stat} options={[{ id: 'instant', name: 'Current' }, { id: 'timeAverage', name: 'Average' }, { id: 'perCellPeak', name: 'Peak' }]} onChange={stat => onChange({ ...layer, stat })} />
      <div className="legend"><span>0</span><i /><span>{layer.field === 'people.density' ? '3.5 p/m²' : '2.0'}</span></div>
    </>}
  </div>;
}

function NumberField({ label, value, unit, step = 0.05, min, max, disabled, onCommit }: { label: string; value: number; unit?: string; step?: number; min?: number; max?: number; disabled?: boolean; onCommit(v: number): void }) {
  return <label className="field"><span>{label}</span>
    <input type="number" key={value} defaultValue={value} step={step} min={min} max={max} disabled={disabled}
      onBlur={e => { const v = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(v) && v !== value) onCommit(v); }}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    {unit && <em>{unit}</em>}
  </label>;
}

function WallInspector({ wall, doc, canEdit, onEdit, onDelete }: { wall: Wall; doc: EgressDocument; canEdit: boolean; onEdit(c: EditCommand[]): void; onDelete(): void }) {
  const a = doc.vertices.find(v => v.id === wall.startVertexId)?.position, b = doc.vertices.find(v => v.id === wall.endVertexId)?.position;
  const length = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
  return <>
    <header className="pane-head"><h2>Wall</h2><span>{length.toFixed(2)} m</span></header>
    <div className="pane-body">
      <div className="field"><span>Type</span><Segmented value={wall.material} disabled={!canEdit} options={WALL_TYPES} onChange={material => onEdit([{ kind: 'updateWall', wallId: wall.id, patch: { material } }])} /></div>
      <NumberField label="Thickness" unit="m" value={wall.thicknessM} min={0.05} max={2} disabled={!canEdit} onCommit={thicknessM => onEdit([{ kind: 'updateWall', wallId: wall.id, patch: { thicknessM } }])} />
      <NumberField label="Height" unit="m" value={wall.heightM} step={0.1} min={0.5} max={50} disabled={!canEdit} onCommit={heightM => onEdit([{ kind: 'updateWall', wallId: wall.id, patch: { heightM } }])} />
    </div>
    <div className="pane-actions"><button className="button danger" disabled={!canEdit} onClick={onDelete}><TrashIcon />Delete</button></div>
  </>;
}

function OpeningInspector({ opening, canEdit, onEdit, onDelete }: { opening: Opening; canEdit: boolean; onEdit(c: EditCommand[]): void; onDelete(): void }) {
  const patch = (p: Extract<EditCommand, { kind: 'updateOpening' }>['patch']) => onEdit([{ kind: 'updateOpening', openingId: opening.id, patch: p }]);
  return <>
    <header className="pane-head"><h2>{opening.openingKind === 'exit' ? 'Exit' : opening.openingKind === 'door' ? 'Door' : 'Window'}</h2><span>{opening.widthM.toFixed(2)} m</span></header>
    <div className="pane-body">
      <div className="field"><span>Kind</span><Segmented value={opening.openingKind} disabled={!canEdit} options={[{ id: 'door', name: 'Door' }, { id: 'window', name: 'Window' }, { id: 'exit', name: 'Exit' }]} onChange={openingKind => patch({ openingKind })} /></div>
      <NumberField label="Width" unit="m" value={opening.widthM} min={0.5} max={20} disabled={!canEdit} onCommit={widthM => patch({ widthM })} />
      {opening.openingKind !== 'window' && <div className="field"><span>State</span><Segmented value={opening.state} disabled={!canEdit} options={[{ id: 'open', name: 'Open' }, { id: 'closed', name: 'Closed' }]} onChange={state => patch({ state })} /></div>}
    </div>
    <div className="pane-actions"><button className="button danger" disabled={!canEdit} onClick={onDelete}><TrashIcon />Delete</button></div>
  </>;
}

// ── Simulate ────────────────────────────────────────────────────────────────

function SimulatePane({ client, playback, running, runFailed, runnerOnline, hasDoc, onRun, onStop }: {
  client: EgressClient; playback: PlaybackController | null; running: boolean; runFailed: string | null; runnerOnline: boolean; hasDoc: boolean;
  onRun(people: number, seed: number): void; onStop(): void;
}) {
  const [people, setPeople] = useState(150), [seed, setSeed] = useState(1);
  void client;
  return <>
    <header className="pane-head"><h2>Population</h2></header>
    <div className="pane-body">
      <label className="field"><span>People</span>
        <input type="range" min={10} max={1000} step={10} value={people} disabled={running} onChange={e => setPeople(Number(e.target.value))} />
        <input type="number" className="narrow" min={1} max={2000} value={people} disabled={running} onChange={e => setPeople(Math.max(1, Math.min(2000, Number(e.target.value) || 1)))} />
      </label>
      <div className="field"><span>Distribution</span><Segmented value="uniform" options={[{ id: 'uniform', name: 'Uniform' }, { id: 'painted', name: 'Painted', disabled: true }]} onChange={() => {}} disabled={running} /></div>
      <label className="field"><span>Seed</span>
        <input type="number" className="narrow" min={0} value={seed} disabled={running} onChange={e => setSeed(Math.max(0, Number(e.target.value) || 0))} />
        <button className="icon-button" data-tip="New seed" disabled={running} onClick={() => setSeed(Math.floor(Math.random() * 100000))}><ArrowPathIcon /></button>
      </label>
      {playback && <RunReadout playback={playback} />}
      {runFailed && <p className="note error">{runFailed}</p>}
      {!runnerOnline && <p className="note warn">Simulation server offline</p>}
    </div>
    <div className="pane-actions">
      {running ? <button className="button danger" onClick={onStop}><StopIcon />Stop</button>
        : <button className="button primary" disabled={!hasDoc} onClick={() => onRun(people, seed)}><PlayIcon />{playback ? 'Run again' : 'Run evacuation'}</button>}
    </div>
  </>;
}

function endText(m: SimulationMetrics | null): string {
  if (!m) return 'Queued';
  if (!m.complete) return 'Running';
  if (m.endReason === 'all-out') return m.unreachablePeople ? 'Everyone reachable is out' : 'Everyone is out';
  if (m.endReason === 'stabilized') return 'Flow stopped changing';
  return 'Time limit reached';
}

function RunReadout({ playback }: { playback: PlaybackController }) {
  const m = useEgress(playback.metrics), s = useEgress(playback.state);
  const rows: [string, string][] = [
    ['Evacuation time', m?.evacuationTimeSeconds != null ? `${m.evacuationTimeSeconds.toFixed(1)} s` : '—'],
    ['Computed to', `${((m?.simulatedSeconds ?? s.liveTick / 10)).toFixed(1)} s`],
    ['Evacuated', m ? `${m.evacuatedPeople} / ${m.initialPeople}` : '—'],
    ['Still inside', m ? String(m.remainingPeople) : '—'],
    ['Max queue', m ? String(m.maxQueueLength) : '—'],
  ];
  if (m?.unreachablePeople) rows.push(['Cannot reach an exit', String(m.unreachablePeople)]);
  return <section className="readout">
    <div className={`run-state ${m?.complete ? 'done' : 'live'}`}>{endText(m)}</div>
    <dl>{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
  </section>;
}

function Transport({ playback, running, onSpeed }: { playback: PlaybackController | null; running: boolean; onSpeed(s: number): void }) {
  if (!playback) return <div className="transport idle"><button className="tool" disabled><BackwardIcon /></button><button className="tool" disabled><PlayIcon /></button><button className="tool" disabled><ForwardIcon /></button><div className="timeline"><input type="range" disabled value={0} min={0} max={1} onChange={() => {}} /><span className="time">0:00.0</span></div></div>;
  return <LiveTransport playback={playback} running={running} onSpeed={onSpeed} />;
}

function LiveTransport({ playback, onSpeed }: { playback: PlaybackController; running: boolean; onSpeed(s: number): void }) {
  const s = useEgress(playback.state);
  return <div className="transport">
    <Tool tip="Back 10 s (←)" onClick={() => playback.skip(-10)}><BackwardIcon /></Tool>
    <Tool tip={s.playing ? 'Pause (Space)' : 'Play (Space)'} on={s.playing} onClick={() => playback.toggle()}>{s.playing ? <PauseIcon /> : <PlayIcon />}</Tool>
    <Tool tip="Forward 10 s (→)" onClick={() => playback.skip(10)}><ForwardIcon /></Tool>
    <div className="timeline">
      <input type="range" min={0} max={Math.max(1, s.liveTick)} step={1} value={Math.min(s.tick, s.liveTick)} onChange={e => playback.seek(Number(e.target.value))} aria-label="Timeline" />
      <span className="time">{clock(s.tick / 10)}</span>
      <button className={`badge ${s.complete ? 'end' : s.atLiveEdge ? 'live on' : 'live'}`} onClick={() => playback.goLive()} data-tip={s.complete ? 'End of run' : 'Jump to the live edge'}>{s.complete ? 'END' : 'LIVE'}</button>
    </div>
    <div className="speeds">{[1, 2, 4].map(v => <button key={v} aria-pressed={s.speed === v} onClick={() => { playback.setSpeed(v); onSpeed(v); }}>{v}×</button>)}</div>
  </div>;
}

// ── Analysis ────────────────────────────────────────────────────────────────

function ChatBar({ client, playback, disabled, onError }: { client: EgressClient; playback: PlaybackController | null; disabled: boolean; onError(e: unknown): void }) {
  const jobs = useEgress(client.agentJobs);
  const [prompt, setPrompt] = useState('');
  const working = jobs.some(j => j.status === 'queued' || j.status === 'running');
  const send = () => {
    const text = prompt.trim() || 'Find the worst bottleneck and propose a measured improvement.';
    const state = playback?.state.get();
    const runId = state?.status === 'complete' ? state.runId : undefined; // the agent measures its own baseline otherwise
    void client.askAgent(text, runId ? { runId } : undefined).then(() => setPrompt('')).catch(onError);
  };
  return <form className="chat" onSubmit={e => { e.preventDefault(); if (!working) send(); }}>
    <SparklesIcon className="chat-icon" />
    <input value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Ask about this layout" disabled={disabled} aria-label="Message the agent" />
    <button className="tool" type="submit" disabled={disabled || working} data-tip={working ? 'Working' : 'Send'}>{working ? <ArrowPathIcon className="spin" /> : <PaperAirplaneIcon />}</button>
  </form>;
}

function stepValue(step: AgentStep): string | null {
  const p = step.payload as Record<string, unknown> | null;
  if (!p || typeof p !== 'object') return null;
  if (step.kind === 'error') return String((p as { message?: unknown }).message ?? 'error');
  const d = p.delta as Record<string, number> | undefined;
  if (step.toolName === 'confirm_candidate' && typeof p.meanSeconds === 'number') return `mean ${signed(p.meanSeconds, ' s')}`;
  if (d && typeof d.effectiveTimeSeconds === 'number') return signed(d.effectiveTimeSeconds, ' s');
  if (typeof p.evacuationTimeSeconds === 'number') return `${p.evacuationTimeSeconds.toFixed(1)} s`;
  if (Array.isArray(p.suggestions)) return `${p.suggestions.length} options`;
  return null;
}

function AnalysisPane({ client, preview, comparison, diffMap, canEdit, onDiffMap, onPreview, onError }: {
  client: EgressClient; preview: ProposalView | null; comparison: RunComparison | null; diffMap: boolean; canEdit: boolean;
  onDiffMap(v: boolean): void; onPreview(id: string | null): void; onError(e: unknown): void;
}) {
  const jobs = useEgress(client.agentJobs), steps = useEgress(client.agentSteps), proposals = useEgress(client.proposals);
  const job = [...jobs].sort((a, b) => b.createdAt - a.createdAt)[0];
  const jobSteps = job ? steps.filter(s => s.jobId === job.id && (s.kind === 'tool_result' || s.kind === 'error')).sort((a, b) => a.seq - b.seq) : [];
  const message = job ? steps.filter(s => s.jobId === job.id && s.kind === 'message').at(-1) : undefined;
  const working = job && (job.status === 'queued' || job.status === 'running');
  const d = preview?.delta ?? {};
  return <>
    <header className="pane-head"><h2>Analysis</h2>{working && <span className="pulse">Working</span>}</header>
    <div className="pane-body">
      {job && <section className="feed">
        <p className="ask">{job.prompt}</p>
        <ol className="steps">{jobSteps.map(s => <li key={s.id} className={s.kind === 'error' ? 'err' : ''}><span>{STEP_LABEL[s.toolName] ?? s.toolName}</span><b>{stepValue(s)}</b></li>)}</ol>
        {(message || job.summary) && <p className="answer">{(message?.payload as { text?: string })?.text ?? job.summary}</p>}
      </section>}
      {preview && <section className="proposal">
        <h3>{preview.status === 'proposed' ? 'Suggested change' : preview.status === 'accepted' ? 'Accepted' : preview.status === 'rejected' ? 'Rejected' : 'Out of date'}</h3>
        <ol className="reasons">{preview.commands.map((_, i) => preview.notes.byCommand[String(i)] && <li key={i}>{firstSentence(preview.notes.byCommand[String(i)])}</li>)}</ol>
        <dl className="delta">
          {typeof d.evacuationTimeSeconds === 'number' && <div><dt>Evacuation time</dt><dd className={d.evacuationTimeSeconds < 0 ? 'good' : 'bad'}>{signed(d.evacuationTimeSeconds, ' s')}</dd></div>}
          {typeof d.maxQueueLength === 'number' && <div><dt>Max queue</dt><dd className={d.maxQueueLength <= 0 ? 'good' : 'bad'}>{signed(d.maxQueueLength)}</dd></div>}
          {typeof d.seedsTested === 'number' && <div><dt>Crowds tested</dt><dd>{d.seedsTested}</dd></div>}
          {typeof d.robustMeanSeconds === 'number' && <div><dt>Mean across crowds</dt><dd className={d.robustMeanSeconds < 0 ? 'good' : 'bad'}>{signed(d.robustMeanSeconds, ' s')}</dd></div>}
          {comparison && <div><dt>Before → after</dt><dd>{comparison.baseline.evacuationTimeSeconds?.toFixed(1) ?? '—'} → {comparison.candidate.evacuationTimeSeconds?.toFixed(1) ?? '—'} s</dd></div>}
        </dl>
        {comparison?.congestionDiff && <label className="check"><input type="checkbox" checked={diffMap} onChange={e => onDiffMap(e.target.checked)} />Difference map</label>}
        {proposals.length > 1 && <div className="field"><span>Proposal</span><select value={preview.id} onChange={e => onPreview(e.target.value)}>{proposals.map((p, i) => <option key={p.id} value={p.id}>#{proposals.length - i} · {p.status}</option>)}</select></div>}
      </section>}
      <p className="fine">Modeled results, not a safety certification.</p>
    </div>
    {preview?.status === 'proposed' && <div className="pane-actions two">
      <button className="button" disabled={!canEdit} onClick={() => void client.rejectProposal(preview.id).catch(onError)}><XMarkIcon />Reject</button>
      <button className="button primary" disabled={!canEdit || !preview.ghost} onClick={() => void client.acceptProposal(preview.id).catch(onError)}><CheckIcon />Accept</button>
    </div>}
  </>;
}

// ── Modals ──────────────────────────────────────────────────────────────────

function ModalFrame({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal"><header><h2>{title}</h2><button className="icon-button" aria-label="Close" onClick={onClose}><XMarkIcon /></button></header>{children}</div>
  </div>;
}

function ProjectsModal({ client, onClose, onOpened, onError }: { client: EgressClient; onClose(): void; onOpened(): void; onError(e: unknown): void }) {
  const projects = useEgress(client.projects), view = useEgress(client.document);
  const [name, setName] = useState('');
  const sorted = [...projects].sort((a, b) => b.updatedAt - a.updatedAt);
  const mine = sorted.filter(p => p.role === 'owner'), shared = sorted.filter(p => p.role !== 'owner');
  const row = (p: typeof projects[number]) => <button key={p.id} className={`project-row ${p.id === view.projectId ? 'current' : ''}`} onClick={() => void client.openProject(p.id).then(onOpened).catch(onError)}>
    <FolderIcon /><span>{p.name}</span>{p.role !== 'owner' && <em>{p.role}</em>}<time>{new Date(p.updatedAt).toLocaleDateString()}</time>
  </button>;
  return <ModalFrame title="Projects" onClose={onClose}>
    <form className="new-project" onSubmit={e => { e.preventDefault(); void client.createProject(name.trim() || 'Untitled plan').then(onOpened).catch(onError); }}>
      <input value={name} onChange={e => setName(e.target.value)} placeholder="New project name" aria-label="New project name" maxLength={80} />
      <button className="button primary" type="submit"><PlusIcon />New</button>
    </form>
    <div className="project-list">
      <div className="list-label">Owned</div>
      {mine.length ? mine.map(row) : <p className="empty">None</p>}
      {shared.length > 0 && <><div className="list-label">Shared with you</div>{shared.map(row)}</>}
    </div>
  </ModalFrame>;
}

function ShareModal({ client, role, backend, onClose }: { client: EgressClient; role: string; backend: string; onClose(): void }) {
  const [link, setLink] = useState(''), [copied, setCopied] = useState(false), [error, setError] = useState('');
  const create = () => {
    setError('');
    void client.createInvite('viewer', 24 * 14).then(code => {
      const url = new URL(location.origin + location.pathname);
      if (backend !== 'server') url.searchParams.set('backend', backend);
      const params = new URLSearchParams(location.search);
      for (const k of ['uri', 'db']) { const v = params.get(k); if (v) url.searchParams.set(k, v); }
      url.searchParams.set('join', code);
      setLink(url.toString());
    }).catch(e => setError(e instanceof Error ? e.message : String(e)));
  };
  return <ModalFrame title="Share" onClose={onClose}>
    <div className="share">
      <p className="fine">People who open the link join as viewers. Owners can change roles.</p>
      {role !== 'owner' ? <p className="note warn">Only owners can create links.</p>
        : link ? <div className="link-row"><LinkIcon /><input readOnly value={link} onFocus={e => e.target.select()} aria-label="Share link" />
          <button className="button" onClick={() => { void navigator.clipboard.writeText(link).then(() => setCopied(true)); }}>{copied ? <CheckIcon /> : null}{copied ? 'Copied' : 'Copy'}</button></div>
        : <button className="button primary" onClick={create}><LinkIcon />Create viewer link</button>}
      {error && <p className="note error">{error}</p>}
    </div>
  </ModalFrame>;
}
