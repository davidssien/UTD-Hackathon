'use client';
/**
 * Egress studio (docs/ARCHITECTURE.md §8 "UI direction v2"): a full-window scene with a
 * compact mode switch, a left pull-tab rail for meta actions, an optional right
 * context pane and a bottom context toolbar. Projects live only on the server
 * (D58); the browser keeps just the SpacetimeDB token.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import {
  ArrowDownTrayIcon, ArrowPathIcon, ArrowRightEndOnRectangleIcon, ArrowRightStartOnRectangleIcon, ArrowUpTrayIcon, ArrowUturnLeftIcon,
  ArrowUturnRightIcon, ArrowsPointingOutIcon, BackspaceIcon, BackwardIcon, BarsArrowUpIcon, CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon,
  CursorArrowRaysIcon, EyeIcon, HandRaisedIcon, ForwardIcon, LinkIcon, LockClosedIcon, PaintBrushIcon, PaperAirplaneIcon, PauseIcon, PencilIcon, PlayIcon, PlusIcon, ShareIcon,
  SignalSlashIcon, Squares2X2Icon, UserIcon, MapIcon, Square3Stack3DIcon, StopIcon, TrashIcon, XMarkIcon,
} from '@heroicons/react/24/outline';
import { createMockClient, createSpacetimeClient, type AgentStep, type EgressClient, type PlaybackController, type ProposalView, type RunComparison } from '@egress/client';
import { useEgress } from '@egress/client/react';
import {
  describeRooms, floorsByLevel, LOCKED_MESSAGE, locksEditing, parseDocument, roomFacts, signedArea, type EditCommand, type PresenceMode, type EgressDocument, type Floor, type Opening, type PopulationBrushStroke,
  type Role, type RoomKind, type ScalarField, type SimulationMetrics, type Slab, type SlabMaterial, type Stair, type Wall, type WallMaterial,
} from '@egress/core';
import { compileFloor, paintWeights, populationCapacity } from '@egress/sim';
import twoRooms from '../../content/scenes/two-rooms-corridor.json';
import type { HeatOverlay, PaintBrush, PaintStroke, SceneHandle, SceneLayer, SceneNote, SceneTool } from './egress-scene';
import SketchImporter from './sketch-importer';
import SavesPage from './saves-page';
import EscapePlans from './escape-plans';
import { buildingToDocument } from '@/lib/import-building';

const Scene = dynamic(() => import('./egress-scene'), { ssr: false, loading: () => <div className="scene-loading" /> });

type Mode = 'edit' | 'simulate' | 'analysis';
type ProjectEntry = { projectId: string; phase: 'request' | 'iso' | 'reveal' | 'top' };
type Modal = 'share' | 'import' | 'plans' | null;
type Menu = { x: number; y: number; wallId: string | null; openingId: string | null; slabId: string | null; stairId: string | null } | null;

const WALL_TYPES: { id: WallMaterial; name: string }[] = [{ id: 'normal', name: 'Normal' }, { id: 'reinforced', name: 'Reinforced' }, { id: 'glass', name: 'Glass' }];
const SLAB_TYPES: { id: SlabMaterial; name: string }[] = [{ id: 'wood', name: 'Wood' }, { id: 'basic', name: 'Basic' }, { id: 'tile', name: 'Tile' }];
const STAIR_EDGES: { id: Stair['upEdge']; name: string }[] = [{ id: 'n', name: 'North' }, { id: 'e', name: 'East' }, { id: 's', name: 'South' }, { id: 'w', name: 'West' }];
const MODE_LABEL: Record<PresenceMode, string> = { edit: 'Editing', simulate: 'Simulating', analysis: 'Analysis' };
const MODES: { id: Mode; name: string; key: string }[] = [{ id: 'edit', name: 'Edit', key: '1' }, { id: 'simulate', name: 'Simulate', key: '2' }, { id: 'analysis', name: 'Analysis', key: '3' }];
const STEP_LABEL: Record<string, string> = {
  inspect_layout: 'Read layout', inspect_run: 'Read run', run_scenario: 'Baseline simulation', get_hotspots: 'Find bottlenecks',
  plan_corner_room: 'Plan room placements', test_edit_batch: 'Test change', confirm_candidate: 'Re-test on new crowds', compare_runs: 'Compare runs', submit_proposal: 'Propose change',
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
          // The saves page is the landing page; only a share link or a project URL opens the editor directly.
          const join = params.get('join'), wanted = params.get('project');
          const link = params.get('link');
          if (link) { await client.joinByLink(link); return; }
          if (join) { await client.joinProject(join); return; }
          if (wanted && client.projects.get().some(p => p.id === wanted)) await client.openProject(wanted);
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
  const view = useEgress(client.document), projects = useEgress(client.projects), status = useEgress(client.status), connectionError = useEgress(client.connectionError);
  const runs = useEgress(client.runs), runner = useEgress(client.runner), proposals = useEgress(client.proposals), jobs = useEgress(client.agentJobs), members = useEgress(client.members);
  const [mode, setMode] = useState<Mode>('edit');
  // Saves page first (D69) unless the URL asks for a project or carries a share link.
  const [screen, setScreen] = useState<'saves' | 'editor'>(() => {
    const p = new URLSearchParams(location.search);
    return p.has('project') || p.has('join') || p.has('link') ? 'editor' : 'saves';
  });
  const [entry, setEntry] = useState<ProjectEntry | null>(null);
  const savesPage = useRef<HTMLElement>(null);
  const openSequence = useRef(0);
  const [tool, setTool] = useState<SceneTool>('select');
  const [wallType, setWallType] = useState<WallMaterial>('normal');
  const [slabType, setSlabType] = useState<SlabMaterial>('wood');
  const [slabMenu, setSlabMenu] = useState<{ x: number; y: number } | null>(null);
  const [floorId, setFloorId] = useState<string | null>(null);
  const [floorPanel, setFloorPanel] = useState(false);
  // Population painting (D76): strokes for the next run; the run keeps its own copy.
  const [distribution, setDistribution] = useState<'uniform' | 'painted'>('uniform');
  const [strokes, setStrokes] = useState<PopulationBrushStroke[]>([]);
  const [brush, setBrush] = useState<PaintBrush | null>(null);
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
  // Right pane collapse, remembered per mode in this browser only (a viewer convenience, not project data).
  const [collapsed, setCollapsed] = useState<Record<Mode, boolean>>(() => {
    const none = { edit: false, simulate: false, analysis: false };
    try { return { ...none, ...JSON.parse(localStorage.getItem('egress.paneCollapsed') ?? '{}') }; } catch { return none; }
  });
  const paneCollapsed = collapsed[mode];
  const setPaneCollapsed = (value: boolean) => setCollapsed(c => {
    const next = { ...c, [mode]: value };
    try { localStorage.setItem('egress.paneCollapsed', JSON.stringify(next)); } catch { /* storage unavailable */ }
    return next;
  });
  const theme = useMemo(() => (new URLSearchParams(location.search).get('theme') === 'black' ? 'black' : 'blueprint'), []);
  const [error, setError] = useState(bootError);
  const scene = useRef<SceneHandle>(null);

  const doc = view.doc;
  // Floors (D75): the switcher picks the viewed floor; tools draw on it.
  const floors = useMemo(() => (doc ? floorsByLevel(doc) : []), [doc]);
  const floor: Floor | null = floors.find(f => f.id === floorId) ?? floors[0] ?? null;
  // Rooms and their labels (D73): editors ask the runner to label rooms that have none yet.
  const roomLabelRows = useEgress(client.roomLabels);
  const labelMap = useMemo(() => new Map(roomLabelRows.map(l => [l.roomHash, l])), [roomLabelRows]);
  const rooms = useMemo(() => (doc ? describeRooms(doc) : []), [doc]);
  const roomKey = rooms.map(r => r.roomHash).sort().join(',');
  const [tagMenu, setTagMenu] = useState<{ hash: string; x: number; y: number } | null>(null);
  const project = projects.find(p => p.id === view.projectId);
  const role = project?.role ?? 'viewer';
  const userRuns = runs.filter(r => !r.agentJobId);
  // Shared live simulation (D89): one user run per project locks the layout while it runs.
  // `now` ticks so a stalled run stops locking without any row changing.
  const [now, setNow] = useState(() => Date.now());
  const pendingRun = userRuns.some(r => r.status === 'queued' || r.status === 'running');
  useEffect(() => {
    if (!pendingRun) return;
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [pendingRun]);
  const liveRun = userRuns.find(r => locksEditing({ status: r.status, agentJobId: r.agentJobId, updatedAtMs: r.updatedAt }, Math.max(now, r.updatedAt))) ?? null;
  const locked = !!liveRun;
  const canEdit = role !== 'viewer';
  const editable = canEdit && !locked;
  // Everyone follows a new shared run as soon as it appears, whoever started it. Speed stays per person.
  const speedRef = useRef(1);
  const followed = useRef<string | null>(null);
  useEffect(() => {
    if (!liveRun || followed.current === liveRun.id) return;
    followed.current = liveRun.id;
    setRunId(liveRun.id);
    const p = client.playback(liveRun.id); p.setSpeed(speedRef.current); p.play(); p.goLive();
  }, [liveRun?.id, client]); // eslint-disable-line react-hooks/exhaustive-deps
  const activeRunId = runId && runs.some(r => r.id === runId) ? runId : userRuns[0]?.id ?? null;
  const playback = useMemo(() => (activeRunId ? client.playback(activeRunId) : null), [client, activeRunId]);
  const activeRun = runs.find(r => r.id === activeRunId);
  const running = activeRun?.status === 'queued' || activeRun?.status === 'running';
  useEffect(() => {
    if (!canEdit || screen !== 'editor' || !rooms.length || rooms.every(r => labelMap.has(r.roomHash))) return;
    const timer = setTimeout(() => { void client.requestRoomLabels(rooms.map(roomFacts)).catch(() => { /* labels are optional */ }); }, 1500);
    return () => clearTimeout(timer);
  }, [roomKey, canEdit, screen, client]); // eslint-disable-line react-hooks/exhaustive-deps

  // Presence by mode (PLAN.md §3 K): tell the others where this person is.
  useEffect(() => {
    if (status !== 'connected') return;
    void client.setMode(screen === 'editor' && view.projectId ? mode : null).catch(() => { /* presence is best-effort */ });
  }, [client, status, screen, mode, view.projectId]);

  // Keep the URL pointing at the open project while editing, so it can be shared or reloaded.
  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.delete('join'); url.searchParams.delete('link');
    if (screen === 'editor' && view.projectId) url.searchParams.set('project', view.projectId);
    else url.searchParams.delete('project');
    if (url.href !== location.href) history.replaceState(null, '', url);
  }, [view.projectId, screen]);
  // A project URL that never opens (deleted, or no access) falls back to the saves page.
  useEffect(() => {
    if (screen !== 'editor' || status !== 'connected' || view.projectId) return;
    const timer = setTimeout(() => setScreen('saves'), 2500);
    return () => clearTimeout(timer);
  }, [screen, status, view.projectId]);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const openFromSaves = (projectId: string) => {
    if (entry) return;
    const attempt = ++openSequence.current;
    setEntry({ projectId, phase: 'request' });
    setError('');
    void client.openProject(projectId).then(() => {
      if (attempt !== openSequence.current) return;
      setEntry({ projectId, phase: 'iso' });
      setSelected(null); setRunId(null); setPreviewId(null); setMode('edit'); setTool('select');
      setFloorId(null); setStrokes([]); setBrush(null); setDistribution('uniform');
    }).catch(e => { if (attempt === openSequence.current) { setEntry(null); fail(e); } });
  };
  // Keep the first rendered isometric view in place as the saves page slides away.
  useEffect(() => {
    if (entry?.phase !== 'reveal') return;
    let live = true;
    const animations = savesPage.current?.getAnimations() ?? [];
    void Promise.allSettled(animations.map(a => a.finished)).then(() => {
      if (live) setEntry({ ...entry, phase: 'top' });
    });
    return () => { live = false; };
  }, [entry]);
  useEffect(() => {
    if (!entry) return;
    const offline = status === 'error' || status === 'disconnected';
    const timer = setTimeout(() => {
      openSequence.current++;
      setEntry(null); setScreen('saves');
      setError(offline ? 'Connection lost while opening the project.' : 'Could not load this project. Open it again to retry.');
    }, offline ? 0 : 30000);
    return () => clearTimeout(timer);
  }, [entry, status]);
  const toSaves = () => { setTagMenu(null); setRail(false); setMenu(null); setTypeMenu(null); setSlabMenu(null); setFloorPanel(false); setLayersOpen(false); setExportOpen(false); setBrush(null); setScreen('saves'); };
  const edit = (commands: EditCommand[]) => {
    if (!canEdit) { setError('You have view access to this project.'); return; }
    if (locked) { setError(LOCKED_MESSAGE); return; }
    void client.edit(commands).then(r => { if (!r.ok) setError(r.error.message); }).catch(fail);
  };
  const switchMode = (next: Mode) => { setMode(next); setTool('select'); setSelected(null); setMenu(null); setTypeMenu(null); setSlabMenu(null); setBrush(null); };
  const choose = (next: SceneTool) => { setTool(next); setSelected(null); setMenu(null); setTypeMenu(null); setSlabMenu(null); };
  const addFloor = () => {
    if (!canEdit || !doc) return;
    const name = `Floor ${floors.length + 1}`;
    void client.edit([{ kind: 'createFloor', name }]).then(r => {
      if (!r.ok) { setError(r.error.message); return; }
      const created = client.document.get().doc?.floors.find(f => f.name === name && !floors.some(o => o.id === f.id));
      if (created) setFloorId(created.id);
    }).catch(fail);
  };
  const paintStroke = (s: PaintStroke) => {
    if (!floor) return;
    setStrokes(list => [...list, { id: `b${Date.now().toString(36)}${list.length}`, floorId: floor.id, points: s.points, radiusM: s.radiusM, mode: s.mode, weight: s.mode === 'erase' ? 0 : s.mode === 'increase' ? 1.5 : -1, falloff: 'linear' as const }].slice(-500));
  };

  // Analysis: preview the newest open proposal on the model.
  const latestJob = jobs.reduce<(typeof jobs)[number] | null>((last, job) => !last || job.createdAt > last.createdAt ? job : last, null);
  const latestPlans = proposals.filter(p => p.jobId === latestJob?.id);
  const pendingPlans = latestPlans.filter(p => p.status === 'proposed');
  const preview = mode === 'analysis' ? proposals.find(p => p.id === previewId)
    ?? pendingPlans.find(p => p.delta.requested === 1) ?? pendingPlans[0] ?? latestPlans[0] ?? null : null;
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
  // While painting, the overlay shows where people will start (relative weight per cell).
  const paintField = useMemo<ScalarField | null>(() => {
    if (mode !== 'simulate' || distribution !== 'painted' || !brush || !doc) return null;
    try {
      const compiled = compileFloor(doc, floor?.id), weights = paintWeights(compiled, strokes);
      const values = new Float32Array(weights.length);
      for (let i = 0; i < weights.length; i++) values[i] = compiled.navigable[i] && compiled.room[i] >= 0 ? weights[i] * 0.9 : NaN;
      return { fieldId: 'people.density', aggregation: 'instant', grid: compiled.grid, units: 'relative', values };
    } catch { return null; }
  }, [mode, distribution, brush, doc, floor, strokes]);
  const overlay: HeatOverlay | null = paintField ? { field: paintField, diverging: false }
    : mode === 'analysis' && diffMap && comparison?.congestionDiff ? { field: comparison.congestionDiff, diverging: true } : null;

  // Keyboard: tools, history, modes.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (entry || screen === 'saves' || (e.target as HTMLElement)?.closest?.('input, textarea, select, dialog')) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) {
        if (mode !== 'edit') return;
        e.preventDefault();
        if (locked) { setError(LOCKED_MESSAGE); return; }
        void ((k === 'y' || e.shiftKey) ? client.redo() : client.undo()).catch(fail); return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') { setTool('select'); setSelected(null); setMenu(null); setTypeMenu(null); setSlabMenu(null); setFloorPanel(false); setLayersOpen(false); setExportOpen(false); setBrush(null); return; }
      if (e.key === 'PageUp' || e.key === 'PageDown') {
        const i = floors.findIndex(f => f.id === floor?.id), next = floors[i + (e.key === 'PageUp' ? 1 : -1)];
        if (next) { e.preventDefault(); setFloorId(next.id); setSelected(null); }
        return;
      }
      const m = MODES.find(x => x.key === e.key); if (m) { switchMode(m.id); return; }
      if (k === 'f') { scene.current?.view('fit'); return; }
      if (mode === 'edit') {
        const tools: Record<string, SceneTool> = { v: 'select', h: 'pan', w: 'wall', r: 'box', g: 'slab', t: 'stair', d: 'door', n: 'window', e: 'exit', x: 'erase' };
        if (tools[k] && (editable || k === 'v' || k === 'h')) { choose(tools[k]); return; }
        if ((e.key === 'Delete' || e.key === 'Backspace') && selected && editable) { e.preventDefault(); edit([{ kind: 'deleteEntities', ids: [selected] }]); setSelected(null); }
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
    setError(''); setBrush(null);
    followed.current = null;
    const painted = distribution === 'painted' && strokes.length > 0;
    void client.startRun({ scenarioVersion: 1, id: `s-${crypto.randomUUID()}`, projectId: doc.projectId, name: 'Evacuate', durationSeconds: 900, population: { count: people, distribution: painted ? 'painted' : 'uniform', strokes: painted ? strokes : [], seed }, goal: { kind: 'evacuate', blockedExitIds: [] } }, 'x4')
      .then(id => { followed.current = id; setRunId(id); const p = client.playback(id); p.setSpeed(speedRef.current); p.play(); })
      .catch(fail);
  };

  const exportJson = () => {
    if (!doc) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `${project?.name ?? 'egress-plan'}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const sceneDoc = ghost?.doc ?? doc;
  const tags = mode === 'edit' ? rooms.filter(r => r.floorId === floor?.id).map(r => ({ key: r.roomHash, text: labelMap.get(r.roomHash)?.name ?? '…', at: r.center, muted: !labelMap.has(r.roomHash) })) : [];
  const wall = doc?.walls.find(w => w.id === selected) ?? null;
  const opening = doc?.openings.find(o => o.id === selected) ?? null;
  const slab = doc?.slabs.find(s => s.id === selected) ?? null;
  const stair = doc?.stairs.find(s => s.id === selected) ?? null;
  const showPane = mode === 'simulate' || (mode === 'edit' && (wall || opening || slab || stair)) || (mode === 'analysis' && (proposals.length > 0 || jobs.length > 0));
  const upperContent = !!doc && floors.length > 1 && doc.walls.some(w => w.floorId !== floors[0].id);
  const saving = view.pending > 0;

  return <><main inert={!!entry} aria-busy={!!entry} className={`studio on-${screen} mode-${mode} theme-${theme} ${menu || typeMenu || slabMenu || exportOpen ? 'menus-open' : ''}`} onContextMenu={e => e.preventDefault()}
    onPointerDownCapture={e => {
      const target = e.target as Element;
      if (!target.closest('.rail-anchor')) setExportOpen(false);
      if (!target.closest('.type-menu, .dock')) { setTypeMenu(null); setSlabMenu(null); }
      if (!target.closest('.context-menu')) setMenu(null);
      if (!target.closest('.floor-switch')) setFloorPanel(false);
      if (!target.closest('.layers-panel, .hud-button')) setLayersOpen(false);
    }}>
    <div className="editor-surface" inert={screen === 'saves'}>
    <Scene ref={scene} theme={theme} doc={sceneDoc} editing={mode === 'edit'} tool={editable || tool === 'pan' ? tool : 'select'} wallType={wallType} selected={selected}
      floorId={floor?.id ?? null} slabMaterial={slabType} paint={mode === 'simulate' ? brush : null} onPaint={paintStroke}
      inputBlocked={screen === 'saves' || !!entry}
      entryView={entry?.projectId === sceneDoc?.projectId && (entry?.phase === 'iso' || entry?.phase === 'top') ? entry.phase : null}
      onEntryFrame={cameraView => {
        if (!entry) return;
        if (cameraView === 'iso') { setScreen('editor'); setEntry({ ...entry, phase: 'reveal' }); }
        else setEntry(null);
      }}
      onEntryError={message => { setEntry(null); setScreen('saves'); setError(message); }}
      highlight={highlight} notes={notes} playback={mode === 'edit' ? null : playback} layer={layer} overlay={overlay}
      onSelect={setSelected} onEdit={edit}
      tags={tags} onTag={(hash, at) => { if (canEdit) setTagMenu({ hash, ...at }); }}
      onContext={(at, hit) => {
        setTypeMenu(null); setSlabMenu(null);
        setMenu(hit && editable ? { ...at, wallId: hit.wallId ?? null, openingId: hit.openingId ?? null, slabId: hit.slabId ?? null, stairId: hit.stairId ?? null } : null);
        if (hit) setSelected(hit.openingId ?? hit.wallId ?? hit.stairId ?? hit.slabId ?? null);
      }} />

    {/* Top left: project + sync state */}
    <button className="project-chip" onClick={toSaves} data-tip="Saves">
      <i className={`sync ${status !== 'connected' ? 'off' : saving ? 'busy' : 'ok'}`} />
      <span>{project?.name ?? (status === 'connected' ? 'Untitled plan' : status === 'error' ? 'Not connected' : 'Connecting…')}</span>
      {role !== 'owner' && project && <em>{role}</em>}
      <ChevronRightIcon />
    </button>

    {/* Top center: modes */}
    <nav className="mode-switch" aria-label="Mode">
      {MODES.map(m => <button key={m.id} aria-pressed={mode === m.id} onClick={() => switchMode(m.id)} data-tip={`${m.name} (${m.key})`}>{m.name}</button>)}
    </nav>

    {locked && mode !== 'simulate' && <div className="lock-banner" role="status"><LockClosedIcon /><span>Simulation running · editing locked</span>
      <button className="button" onClick={() => switchMode('simulate')}><EyeIcon />Watch</button>
      {canEdit && <button className="button danger" onClick={() => { if (liveRun) void client.cancelRun(liveRun.id).catch(fail); }}><StopIcon />Stop</button>}
    </div>}

    {/* Right column: server state and Layers on top, Layers panel, then the context pane; nothing overlaps (D70) */}
    <div className="right-column">
      <div className="hud-right">
        {!runner.online && backend !== 'mock' && <span className="chip warn" data-tip="Runs and the agent wait until the simulation server is back"><SignalSlashIcon />Sim server offline</span>}
        {members.length > 0 && <div className={`presence ${locked ? 'locked' : ''}`} tabIndex={0}
          aria-label={`${members.filter(m => m.online).length} people on this project${locked ? '; editing is locked while a simulation runs' : ''}`}>
          {locked ? <LockClosedIcon /> : <UserIcon />}<span>{members.filter(m => m.online).length}</span>
          <div className="presence-pop" role="tooltip">
            {locked && <p className="lock-note">Simulation running. Editing unlocks when it ends or someone stops it.</p>}
            {members.filter(m => m.online).map(m => <div key={m.identity}><i className="dot on" /><code>{m.identity.slice(0, 10)}…</code>{m.me && <em>You</em>}
              <span>{m.mode ? MODE_LABEL[m.mode] : ''}{m.mode ? ' · ' : ''}{m.role}</span></div>)}
          </div>
        </div>}
        <button className={`hud-button ${layersOpen ? 'on' : ''}`} onClick={() => { setLayersOpen(v => !v); setExportOpen(false); }} aria-expanded={layersOpen}><Square3Stack3DIcon />Layers<ChevronDownIcon className="caret" /></button>
      </div>
      {layersOpen && <LayersPanel layer={layer} onChange={setLayer} />}
      {showPane && <aside className="pane" aria-label="Details" aria-hidden={paneCollapsed} inert={paneCollapsed}>
        <button className="pane-collapse" aria-label="Collapse panel" data-tip="Collapse" data-tip-side="left" onClick={() => setPaneCollapsed(true)}><ChevronRightIcon /></button>
        {mode === 'edit' && wall && <WallInspector wall={wall} canEdit={editable} onEdit={edit} onDelete={() => { edit([{ kind: 'deleteEntities', ids: [wall.id] }]); setSelected(null); }} doc={doc!} />}
        {mode === 'edit' && opening && <OpeningInspector opening={opening} canEdit={editable} onEdit={edit} onDelete={() => { edit([{ kind: 'deleteEntities', ids: [opening.id] }]); setSelected(null); }} />}
        {mode === 'edit' && slab && <SlabInspector slab={slab} canEdit={editable} onEdit={edit} onDelete={() => { edit([{ kind: 'deleteEntities', ids: [slab.id] }]); setSelected(null); }} />}
        {mode === 'edit' && stair && doc && <StairInspector stair={stair} doc={doc} canEdit={editable} onEdit={edit} onDelete={() => { edit([{ kind: 'deleteEntities', ids: [stair.id] }]); setSelected(null); }} />}
        {mode === 'simulate' && <SimulatePane doc={doc} playback={playback} running={running} runFailed={activeRun?.status === 'failed' ? activeRun.error?.message ?? 'Run failed' : null} runnerOnline={runner.online || backend === 'mock'} onRun={startRun} onStop={() => { if (activeRunId) void client.cancelRun(activeRunId).catch(fail); }}
          distribution={distribution} onDistribution={d => { setDistribution(d); setBrush(d === 'painted' ? { radiusM: 2, mode: 'increase' } : null); }}
          brush={brush} onBrush={setBrush} strokes={strokes} onClearStrokes={() => setStrokes([])} onUndoStroke={() => setStrokes(list => list.slice(0, -1))} upperFloors={upperContent}
          canRun={canEdit} />}
        {mode === 'analysis' && <AnalysisPane client={client} preview={preview} comparison={comparison} diffMap={diffMap} onDiffMap={setDiffMap} onPreview={setPreviewId} canEdit={canEdit} locked={locked} onError={fail} />}
      </aside>}
    </div>
    {showPane && paneCollapsed && <button className="pane-tab" aria-label="Open panel" onClick={() => setPaneCollapsed(false)}><ChevronLeftIcon /></button>}

    {/* Left: pull tab → meta rail */}
    <nav className="rail" aria-label="Project" aria-hidden={!rail} inert={!rail}>
      <RailButton tip="Share" onClick={() => setModal('share')}><ShareIcon /></RailButton>
      <RailButton tip="Escape plans" onClick={() => setModal('plans')}><MapIcon /></RailButton>
      <RailButton tip="Import plan image" onClick={() => setModal('import')}><ArrowUpTrayIcon /></RailButton>
      <div className="rail-anchor">
        <RailButton tip="Export" onClick={() => setExportOpen(v => !v)}><ArrowDownTrayIcon /></RailButton>
        {exportOpen && <div className="menu rail-menu">
          <button disabled={!doc} onClick={() => { exportJson(); setExportOpen(false); }}>Plan (.json)</button>
          <button onClick={() => { scene.current?.exportImage(); setExportOpen(false); }}>Image (.png)</button>
        </div>}
      </div>
      <RailButton tip="Frame model (F)" onClick={() => scene.current?.view('fit')}><ArrowsPointingOutIcon /></RailButton>
      <span className="rail-sep" />
      <RailButton tip="Collapse" onClick={() => { setRail(false); setExportOpen(false); }}><ChevronLeftIcon /></RailButton>
    </nav>
    {!rail && <button className="rail-tab" aria-label="Open project menu" onClick={() => setRail(true)}><ChevronRightIcon /></button>}

    {/* Bottom: context toolbar */}
    <footer className="dock" aria-label={`${mode} tools`}>
      {mode === 'edit' && <>
        <Tool tip="Select (V)" on={tool === 'select'} onClick={() => choose('select')}><CursorArrowRaysIcon /></Tool>
        <Tool tip="Pan (H)" on={tool === 'pan'} onClick={() => choose('pan')}><HandRaisedIcon /></Tool>
        <Tool tip={`Wall · ${WALL_TYPES.find(t => t.id === wallType)!.name} (W) · right-click for type`} on={tool === 'wall'} disabled={!editable} onClick={() => choose('wall')}
          onContextMenu={e => { e.preventDefault(); if (!editable) return; const r = e.currentTarget.getBoundingClientRect(); setMenu(null); setTypeMenu({ x: r.left + r.width / 2, y: r.top }); }}>
          <PencilIcon /><i className={`swatch ${wallType}`} />
        </Tool>
        <Tool tip="Room (R)" on={tool === 'box'} disabled={!editable} onClick={() => choose('box')}><StopIcon /></Tool>
        <Tool tip={`Floor · ${SLAB_TYPES.find(t => t.id === slabType)!.name} (G) · click a room or drag · right-click for finish`} on={tool === 'slab'} disabled={!editable} onClick={() => choose('slab')}
          onContextMenu={e => { e.preventDefault(); if (!editable) return; const r = e.currentTarget.getBoundingClientRect(); setMenu(null); setTypeMenu(null); setSlabMenu({ x: r.left + r.width / 2, y: r.top }); }}>
          <Squares2X2Icon /><i className={`swatch floor-${slabType}`} />
        </Tool>
        <Tool tip={floor && floors.some(f => f.level === floor.level + 1) ? 'Stair (T) · drag toward the top' : 'Stair (T) · add a floor above first'} on={tool === 'stair'} disabled={!editable} onClick={() => choose('stair')}><BarsArrowUpIcon /></Tool>
        <span className="sep" />
        <Tool tip="Door (D)" on={tool === 'door'} disabled={!editable} onClick={() => choose('door')}><ArrowRightEndOnRectangleIcon /></Tool>
        <Tool tip="Window (N)" on={tool === 'window'} disabled={!editable} onClick={() => choose('window')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden><path d="M4 3.5h16v16H4z M12 3.5v16 M4 10h16 M2 21h20" /></svg></Tool>
        <Tool tip="Exit (E)" on={tool === 'exit'} disabled={!editable} onClick={() => choose('exit')}><ArrowRightStartOnRectangleIcon /></Tool>
        <span className="sep" />
        <Tool tip="Erase (X) · click or drag across walls" on={tool === 'erase'} disabled={!editable} onClick={() => choose('erase')}><BackspaceIcon /></Tool>
        <span className="sep" />
        <Tool tip="Undo (Ctrl+Z)" disabled={!view.canUndo || !editable} onClick={() => void client.undo().catch(fail)}><ArrowUturnLeftIcon /></Tool>
        <Tool tip="Redo (Ctrl+Shift+Z)" disabled={!view.canRedo || !editable} onClick={() => void client.redo().catch(fail)}><ArrowUturnRightIcon /></Tool>
      </>}
      {mode === 'simulate' && <Transport playback={playback} running={running} onSpeed={s => { speedRef.current = s; }} />}
      {mode === 'analysis' && <ChatBar client={client} playback={playback} onSent={() => setPreviewId(null)} onError={fail} disabled={!doc} />}
    </footer>

    {/* Bottom left: floor switcher (D75) */}
    {doc && floor && <div className="floor-switch" aria-label="Floor">
      <button className="icon-button" aria-label="Floor below" data-tip="Floor below (PgDn)" disabled={floors[0]?.id === floor.id} onClick={() => { const i = floors.findIndex(f => f.id === floor.id); setFloorId(floors[i - 1]?.id ?? floor.id); setSelected(null); }}><ChevronLeftIcon /></button>
      <button className="floor-name" onClick={() => setFloorPanel(v => !v)} aria-expanded={floorPanel} data-tip="Floor settings">{floor.name || `Floor ${floor.level + 1}`}<em>{floor.elevationM.toFixed(1)} m</em></button>
      <button className="icon-button" aria-label="Floor above" data-tip="Floor above (PgUp)" disabled={floors.at(-1)?.id === floor.id} onClick={() => { const i = floors.findIndex(f => f.id === floor.id); setFloorId(floors[i + 1]?.id ?? floor.id); setSelected(null); }}><ChevronRightIcon /></button>
      {editable && mode === 'edit' && <button className="icon-button" aria-label="Add a floor on top" data-tip="Add floor on top" onClick={addFloor}><PlusIcon /></button>}
      {floorPanel && <FloorPanel floor={floor} count={floors.length} canEdit={editable && mode === 'edit'} onClose={() => setFloorPanel(false)}
        onEdit={patch => edit([{ kind: 'updateFloor', floorId: floor.id, patch }])}
        onDelete={() => { edit([{ kind: 'deleteEntities', ids: [floor.id] }]); setFloorId(null); setFloorPanel(false); }} />}
    </div>}

    {slabMenu && <div className="menu type-menu" style={{ left: slabMenu.x, top: slabMenu.y }}>
      {SLAB_TYPES.map(t => <button key={t.id} aria-pressed={slabType === t.id} onClick={() => { setSlabType(t.id); setTool('slab'); setSlabMenu(null); }}><i className={`swatch floor-${t.id}`} />{t.name}{slabType === t.id && <CheckIcon />}</button>)}
    </div>}
    {typeMenu && <div className="menu type-menu" style={{ left: typeMenu.x, top: typeMenu.y }}>
      {WALL_TYPES.map(t => <button key={t.id} aria-pressed={wallType === t.id} onClick={() => { setWallType(t.id); setTool('wall'); setTypeMenu(null); }}><i className={`swatch ${t.id}`} />{t.name}{wallType === t.id && <CheckIcon />}</button>)}
    </div>}
    {menu && <div className="menu context-menu" style={{ left: menu.x, top: menu.y }}>
      {menu.wallId && !menu.openingId && WALL_TYPES.map(t => <button key={t.id} onClick={() => { edit([{ kind: 'updateWall', wallId: menu.wallId!, patch: { material: t.id } }]); setMenu(null); }}>
        <i className={`swatch ${t.id}`} />{t.name}{doc?.walls.find(w => w.id === menu.wallId)?.material === t.id && <CheckIcon />}</button>)}
      {menu.wallId && !menu.openingId && <hr />}
      {!menu.wallId && menu.slabId && !menu.stairId && <>{SLAB_TYPES.map(t => <button key={t.id} onClick={() => { edit([{ kind: 'updateSlab', slabId: menu.slabId!, patch: { material: t.id } }]); setMenu(null); }}>
        <i className={`swatch floor-${t.id}`} />{t.name}{doc?.slabs.find(s => s.id === menu.slabId)?.material === t.id && <CheckIcon />}</button>)}<hr /></>}
      <button className="danger" onClick={() => { edit([{ kind: 'deleteEntities', ids: [menu.openingId ?? menu.wallId ?? menu.stairId ?? menu.slabId!] }]); setSelected(null); setMenu(null); }}><TrashIcon />Delete</button>
    </div>}

    {tagMenu && <RoomTagMenu at={tagMenu} label={labelMap.get(tagMenu.hash)} onClose={() => setTagMenu(null)}
      onSave={(kind, name) => { void client.setRoomLabel(tagMenu.hash, kind, name).catch(fail); setTagMenu(null); }} />}
    </div>

    {(error || view.lastError || (status === 'error' && connectionError)) && <div className="toast" role="alert"><span>{error || view.lastError?.message || connectionError}</span><button aria-label="Dismiss" onClick={() => setError('')}><XMarkIcon /></button></div>}

    <SavesPage pageRef={savesPage} client={client} active={screen === 'saves'} onOpen={openFromSaves} onImportImage={() => setModal('import')}
      onCreateExample={x => x.load().then(d => client.createProject(x.name, d))} onError={fail} />

    {modal === 'plans' && doc && <ModalFrame title="Escape plans" wide onClose={() => setModal(null)}><EscapePlans doc={doc} labels={labelMap} projectName={project?.name ?? 'Plan'} /></ModalFrame>}
    {modal === 'share' && <ShareModal client={client} role={role} backend={backend} onClose={() => setModal(null)} />}
    {modal === 'import' && <div className="modal-backdrop" role="dialog" aria-modal="true"><div className="modal import-host">
      <SketchImporter current={null} onClose={() => setModal(null)} onImport={building => {
        const name = `Imported plan ${new Date().toLocaleDateString()}`;
        // CV floor-plan scanning is the partner's area; this seam stays stable (PLAN.md D87).
        void client.createProject(name, buildingToDocument(building)).then(() => { setSelected(null); setRunId(null); switchMode('edit'); setScreen('editor'); }).catch(fail);
      }} />
    </div></div>}
  </main>{entry && <div className="project-entry" role="status"><span>Opening project…</span></div>}</>;
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

function LayersPanel({ layer, onChange }: { layer: SceneLayer; onChange(l: SceneLayer): void }) {
  return <div className="layers-panel" aria-label="Layers">
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

function SlabInspector({ slab, canEdit, onEdit, onDelete }: { slab: Slab; canEdit: boolean; onEdit(c: EditCommand[]): void; onDelete(): void }) {
  return <>
    <header className="pane-head"><h2>Floor surface</h2><span>{Math.abs(signedArea(slab.polygon)).toFixed(1)} m²</span></header>
    <div className="pane-body">
      <div className="field"><span>Finish</span><Segmented value={slab.material} disabled={!canEdit} options={SLAB_TYPES} onChange={material => onEdit([{ kind: 'updateSlab', slabId: slab.id, patch: { material } }])} /></div>
    </div>
    <div className="pane-actions"><button className="button danger" disabled={!canEdit} onClick={onDelete}><TrashIcon />Delete</button></div>
  </>;
}

function StairInspector({ stair, doc, canEdit, onEdit, onDelete }: { stair: Stair; doc: EgressDocument; canEdit: boolean; onEdit(c: EditCommand[]): void; onDelete(): void }) {
  const from = doc.floors.find(f => f.id === stair.floorId), to = doc.floors.find(f => f.id === stair.toFloorId);
  const w = stair.max.x - stair.min.x, d = stair.max.y - stair.min.y;
  return <>
    <header className="pane-head"><h2>Stair</h2><span>{w.toFixed(2)} × {d.toFixed(2)} m</span></header>
    <div className="pane-body">
      <div className="field"><span>Connects</span><b className="value">{from?.name ?? '?'} → {to?.name ?? '?'}</b></div>
      <div className="field"><span>Top side</span><Segmented value={stair.upEdge} disabled={!canEdit} options={STAIR_EDGES} onChange={upEdge => onEdit([{ kind: 'updateStair', stairId: stair.id, patch: { upEdge } }])} /></div>
    </div>
    <div className="pane-actions"><button className="button danger" disabled={!canEdit} onClick={onDelete}><TrashIcon />Delete</button></div>
  </>;
}

function FloorPanel({ floor, count, canEdit, onEdit, onDelete, onClose }: {
  floor: Floor; count: number; canEdit: boolean; onEdit(p: { name?: string; ceilingHeightM?: number }): void; onDelete(): void; onClose(): void;
}) {
  return <div className="menu floor-panel" onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
    <label className="field"><span>Name</span><input key={floor.name} defaultValue={floor.name} maxLength={80} disabled={!canEdit}
      onBlur={e => { const v = e.target.value.trim(); if (v && v !== floor.name) onEdit({ name: v }); }} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></label>
    <NumberField label="Floor to floor" unit="m" value={floor.ceilingHeightM} step={0.1} min={2} max={50} disabled={!canEdit} onCommit={ceilingHeightM => onEdit({ ceilingHeightM })} />
    <p className="fine">Changing the height moves every floor above.</p>
    {canEdit && count > 1 && <button className="danger" onClick={onDelete}><TrashIcon />Delete floor and its contents</button>}
  </div>;
}

// ── Simulate ────────────────────────────────────────────────────────────────

function SimulatePane({ doc, playback, running, runFailed, runnerOnline, onRun, onStop, distribution, onDistribution, brush, onBrush, strokes, onClearStrokes, onUndoStroke, upperFloors, canRun }: {
  doc: EgressDocument | null; playback: PlaybackController | null; running: boolean; runFailed: string | null; runnerOnline: boolean; canRun: boolean;
  onRun(people: number, seed: number): void; onStop(): void;
  distribution: 'uniform' | 'painted'; onDistribution(d: 'uniform' | 'painted'): void;
  brush: PaintBrush | null; onBrush(b: PaintBrush | null): void; strokes: PopulationBrushStroke[]; onClearStrokes(): void; onUndoStroke(): void; upperFloors: boolean;
}) {
  const [requested, setPeople] = useState(150), [seed, setSeed] = useState(1);
  const capacity = useMemo(() => doc ? populationCapacity(doc, { count: 2000, seed, distribution, strokes }) : 0,
    [doc, seed, distribution, strokes]);
  const people = Math.min(requested, capacity);
  return <>
    <header className="pane-head"><h2>Population</h2></header>
    <div className="pane-body">
      <label className="field"><span>People</span>
        <input type="range" aria-label="Population" min={capacity ? 1 : 0} max={capacity} step={1} value={people} disabled={running || !capacity} onChange={e => setPeople(Number(e.target.value))} />
        <input type="number" className="narrow" aria-label="Population count" min={capacity ? 1 : 0} max={capacity} value={people} disabled={running || !capacity} onChange={e => setPeople(Math.max(1, Math.min(capacity, Math.trunc(Number(e.target.value)) || 1)))} />
      </label>
      <div className="field"><span>Distribution</span><Segmented value={distribution} options={[{ id: 'uniform', name: 'Uniform' }, { id: 'painted', name: 'Painted' }]} onChange={onDistribution} disabled={running} /></div>
      {distribution === 'painted' && <div className="paint-box">
        <div className="field"><span>Brush</span>
          <button className={`icon-button ${brush ? 'on' : ''}`} aria-pressed={!!brush} data-tip={brush ? 'Put the brush away' : 'Paint on the floor plan'} disabled={running} onClick={() => onBrush(brush ? null : { radiusM: 2, mode: 'increase' })}><PaintBrushIcon /></button>
          <Segmented value={brush?.mode ?? 'increase'} disabled={running || !brush} options={[{ id: 'increase', name: 'More' }, { id: 'decrease', name: 'Fewer' }, { id: 'erase', name: 'Reset' }]} onChange={mode => brush && onBrush({ ...brush, mode })} />
        </div>
        <label className="field"><span>Size</span>
          <input type="range" min={0.5} max={8} step={0.25} value={brush?.radiusM ?? 2} disabled={running || !brush} onChange={e => brush && onBrush({ ...brush, radiusM: Number(e.target.value) })} />
          <em>{(brush?.radiusM ?? 2).toFixed(2)} m</em>
        </label>
        <div className="field"><span>{strokes.length} stroke{strokes.length === 1 ? '' : 's'}</span>
          <button className="button" disabled={!strokes.length || running} onClick={onUndoStroke}><ArrowUturnLeftIcon />Undo</button>
          <button className="button" disabled={!strokes.length || running} onClick={onClearStrokes}><XMarkIcon />Clear</button>
        </div>
        <p className="fine">Painting changes where people start, not how many. Left-drag on the plan while the brush is out.</p>
      </div>}
      <label className="field"><span>Seed</span>
        <input type="number" className="narrow" min={0} value={seed} disabled={running} onChange={e => setSeed(Math.max(0, Number(e.target.value) || 0))} />
        <button className="icon-button" data-tip="New seed" disabled={running} onClick={() => setSeed(Math.floor(Math.random() * 100000))}><ArrowPathIcon /></button>
      </label>
      {!capacity && <p className="note">There is no space to place people in the current layout and distribution.</p>}
      {playback && <RunReadout playback={playback} doc={doc} />}
      {runFailed && <p className="note error">{runFailed}</p>}
      {!runnerOnline && <p className="note warn">Simulation server offline</p>}
      {running && <p className="note">Everyone on this project sees this run live, and editing is locked until it ends.</p>}
      {upperFloors && <p className="note">People start across walkable floors. Use the floor selector to follow them through exits and down stairs.</p>}
    </div>
    <div className="pane-actions">
      {running ? <button className="button danger" disabled={!canRun} onClick={onStop}><StopIcon />Stop</button>
        : <button className="button primary" disabled={!capacity || !canRun} onClick={() => onRun(people, seed)}><PlayIcon />{playback ? 'Run again' : 'Run evacuation'}</button>}
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

function RunReadout({ playback, doc }: { playback: PlaybackController; doc: EgressDocument | null }) {
  const m = useEgress(playback.metrics), s = useEgress(playback.state);
  const rows: [string, string][] = [
    ['Evacuation time', m?.evacuationTimeSeconds != null ? `${m.evacuationTimeSeconds.toFixed(1)} s` : '—'],
    ['Computed to', `${((m?.simulatedSeconds ?? s.liveTick / 10)).toFixed(1)} s`],
    ['Evacuated', m ? `${m.evacuatedPeople} / ${m.initialPeople}` : '—'],
    ['Still inside', m ? String(m.remainingPeople) : '—'],
    ['Max queue', m ? String(m.maxQueueLength) : '—'],
  ];
  if (m?.perFloor) {
    for (const f of doc ? floorsByLevel(doc) : []) {
      const counts = m.perFloor[f.id];
      if (counts) rows.push([f.name, `${counts.started} started · ${counts.exitedHere} exited here`]);
    }
    rows.push(['Stair descents', String(Object.values(m.perFloor).reduce((sum, f) => sum + f.stairDescents, 0))]);
  }
  if (m?.unreachablePeople) rows.push(['Cannot reach an exit', String(m.unreachablePeople)]);
  if (m?.exitSwitches !== undefined) rows.push(['Exit changes', m.exitReversals ? `${m.exitSwitches} (${m.exitReversals} back)` : String(m.exitSwitches)]);
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

function ChatBar({ client, playback, disabled, onSent, onError }: { onSent(): void; client: EgressClient; playback: PlaybackController | null; disabled: boolean; onError(e: unknown): void }) {
  const jobs = useEgress(client.agentJobs);
  const [prompt, setPrompt] = useState('');
  const working = jobs.some(j => j.status === 'queued' || j.status === 'running');
  const send = () => {
    const text = prompt.trim() || 'Find the worst bottleneck and propose a measured improvement.';
    const state = playback?.state.get();
    const runId = state?.status === 'complete' ? state.runId : undefined; // the agent measures its own baseline otherwise
    void client.askAgent(text, runId ? { runId } : undefined).then(() => { setPrompt(''); onSent(); }).catch(onError);
  };
  return <form className="chat" onSubmit={e => { e.preventDefault(); if (!working) send(); }}>
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

function AnalysisPane({ client, preview, comparison, diffMap, canEdit, locked, onDiffMap, onPreview, onError }: {
  client: EgressClient; preview: ProposalView | null; comparison: RunComparison | null; diffMap: boolean; canEdit: boolean; locked: boolean;
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
      </section>}
      {(proposals.length > 1 || (!preview && proposals.length > 0)) && <label className="field"><span>Proposal</span>
        <select value={preview?.id ?? ''} onChange={e => onPreview(e.target.value)}>
          {!preview && <option value="">Choose a previous proposal</option>}
          {proposals.map((p, i) => <option key={p.id} value={p.id}>#{i + 1} · {p.status}</option>)}
        </select>
      </label>}
      {preview?.status === 'proposed' && !preview.ghost && <p className="note">The layout changed. Request a new plan to review this edit.</p>}
      <p className="fine">Modeled results, not a safety certification.</p>
    </div>
    {preview?.status === 'proposed' && <div className="pane-actions two">
      <button className="button" disabled={!canEdit} onClick={() => void client.rejectProposal(preview.id).catch(onError)}><XMarkIcon />Reject</button>
      <button className="button primary" disabled={!canEdit || !preview.ghost || locked} data-tip={locked ? 'Editing is locked while a simulation runs' : undefined} onClick={() => void client.acceptProposal(preview.id).catch(onError)}><CheckIcon />Accept</button>
    </div>}
  </>;
}

// ── Modals ──────────────────────────────────────────────────────────────────

function ModalFrame({ title, onClose, children, wide }: { title: string; onClose(): void; children: ReactNode; wide?: boolean }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={`modal ${wide ? 'wide' : ''}`}><header><h2>{title}</h2><button className="icon-button" aria-label="Close" onClick={onClose}><XMarkIcon /></button></header>{children}</div>
  </div>;
}

const ROOM_KINDS: { id: RoomKind; name: string }[] = [
  { id: 'room', name: 'Room' }, { id: 'hallway', name: 'Hallway' }, { id: 'lobby', name: 'Lobby' },
  { id: 'stair', name: 'Stair' }, { id: 'closet', name: 'Closet' }, { id: 'other', name: 'Other' },
];

function RoomTagMenu({ at, label, onSave, onClose }: { at: { x: number; y: number }; label: { kind: RoomKind; name: string; source: string } | undefined; onSave(kind: RoomKind, name: string): void; onClose(): void }) {
  const [kind, setKind] = useState<RoomKind>(label?.kind ?? 'room'), [name, setName] = useState(label?.name ?? '');
  return <form className="menu room-menu" style={{ left: at.x, top: at.y }} onSubmit={e => { e.preventDefault(); if (name.trim()) onSave(kind, name.trim()); }} onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
    <div className="menu-label">Room{label ? ` · labelled by ${label.source === 'nemotron' ? 'Nemotron' : label.source}` : ''}</div>
    <input autoFocus value={name} onChange={e => setName(e.target.value)} maxLength={60} aria-label="Room name" placeholder="Name" />
    <select value={kind} onChange={e => setKind(e.target.value as RoomKind)} aria-label="Room kind">{ROOM_KINDS.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}</select>
    <div className="menu-row"><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="primary">Save</button></div>
  </form>;
}

function ShareModal({ client, role, backend, onClose }: { client: EgressClient; role: Role; backend: string; onClose(): void }) {
  const members = useEgress(client.members);
  const [code, setCode] = useState(''), [copied, setCopied] = useState(false), [error, setError] = useState('');
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  useEffect(() => { let live = true; client.shareLink().then(c => { if (live) setCode(c); }).catch(fail); return () => { live = false; }; }, [client]);
  const url = useMemo(() => {
    if (!code) return '';
    const u = new URL(location.origin + location.pathname);
    if (backend !== 'server') u.searchParams.set('backend', backend);
    const params = new URLSearchParams(location.search);
    for (const k of ['uri', 'db']) { const v = params.get(k); if (v) u.searchParams.set(k, v); }
    u.searchParams.set('link', code);
    return u.toString();
  }, [code, backend]);
  const owner = role === 'owner';
  const owners = members.filter(m => m.role === 'owner').length;
  return <ModalFrame title="Share" onClose={onClose}>
    <div className="share">
      <p className="fine">Anyone with the link joins as a viewer. Owners can change roles.</p>
      <div className="link-row"><LinkIcon /><input readOnly value={url || 'Creating link…'} onFocus={e => e.target.select()} aria-label="Share link" />
        <button className="button" disabled={!url} onClick={() => { void navigator.clipboard.writeText(url).then(() => setCopied(true)); }}>{copied ? <CheckIcon /> : null}{copied ? 'Copied' : 'Copy'}</button>
        {owner && <button className="button" data-tip="Replace the link; the old one stops working" onClick={() => { setCopied(false); void client.resetShareLink().then(setCode).catch(fail); }}><ArrowPathIcon />Reset</button>}
      </div>
      <div className="list-label">People ({members.filter(m => m.online).length} online)</div>
      <ul className="member-list">
        {members.map(m => <li key={m.identity}>
          <i className={`dot ${m.online ? 'on' : ''}`} aria-label={m.online ? 'Online' : 'Offline'} />
          <code title={m.identity}>{m.identity.slice(0, 10)}…</code>
          {m.me && <em>You</em>}
          <select aria-label={`Role of ${m.identity.slice(0, 10)}`} value={m.role} disabled={!owner || (m.role === 'owner' && owners === 1)}
            onChange={e => void client.setMemberRole(m.identity, e.target.value as Role).catch(fail)}>
            <option value="viewer">Viewer</option><option value="editor">Editor</option><option value="owner">Owner</option>
          </select>
          {(owner || m.me) && !(m.role === 'owner' && owners === 1) && <button className="icon-button" aria-label={m.me ? 'Leave project' : 'Remove from project'} data-tip={m.me ? 'Leave' : 'Remove'}
            onClick={() => void client.removeMember(m.identity).catch(fail)}><XMarkIcon /></button>}
        </li>)}
      </ul>
      {error && <p className="note error">{error}</p>}
    </div>
  </ModalFrame>;
}
