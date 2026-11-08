'use client';

/**
 * /dev — deliberately plain backend test page (Plan.md §8, Q2 of the planning
 * session). Exercises every EgressClient loop: Edit tools, Live playback with
 * the LIVE edge, Analysis chat with ghost previews. The ExitCraft UI replaces
 * it at merge; keep it boring and correct.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  ACTOR_EXITED, ACTOR_QUEUED, CELL_SIZE_M, TICK_RATE_HZ, deriveLayout, parseDocument, projectOnSegment,
  type Aggregation, type EditCommand, type EgressDocument, type OpeningKind, type Pace, type PopulationBrushStroke, type ScalarField, type Vec2,
} from '@egress/core';
import { createMockClient, createSpacetimeClient, type EgressClient, type PlaybackController, type ProposalView } from '@egress/client';
import { useEgress } from '@egress/client/react';
import { compileFloor, paintWeights, structuralField, type StructuralFieldId } from '@egress/sim';
import oneRoom from '../../../content/scenes/one-room.json';
import twoRooms from '../../../content/scenes/two-rooms-corridor.json';
import hall from '../../../content/scenes/hall.json';

type Mode = 'edit' | 'live' | 'analysis';
type Tool = 'pen' | 'box' | 'erase' | 'door' | 'exit' | 'window';
const WALL = { thicknessM: 0.2, heightM: 2.8, material: 'normal' as const };
const OPENING_WIDTH: Record<OpeningKind, number> = { door: 0.9, exit: 1.2, window: 1.2 };

const noopSubscribe = () => () => {};

const FIXTURES = [
  { name: 'Two rooms + corridor', doc: () => parseDocument(twoRooms) },
  { name: 'One room', doc: () => parseDocument(oneRoom) },
  { name: 'Hall (30 × 20 m)', doc: () => parseDocument(hall) },
];

export default function DevHarness() {
  // Browser-only: the client owns timers and random ids, so never create it during SSR.
  const isBrowser = useSyncExternalStore(noopSubscribe, () => true, () => false);
  // /dev?backend=local uses the real local SpacetimeDB (+ a running runner); default is the in-browser mock.
  const backend = isBrowser ? new URLSearchParams(window.location.search).get('backend') ?? 'mock' : 'mock';
  const client = useMemo<EgressClient | null>(() => {
    if (!isBrowser) return null;
    if (backend === 'local') return createSpacetimeClient({ uri: 'ws://127.0.0.1:3010', db: 'egress-local' });
    return createMockClient({ seed: FIXTURES.map(f => ({ name: f.name, doc: f.doc() })) });
  }, [isBrowser, backend]);
  if (!client) return <div style={{ padding: 24, fontFamily: 'system-ui' }}>Starting backend…</div>;
  return <Harness client={client} backend={backend} />;
}

function Harness({ client, backend }: { client: EgressClient; backend: string }) {
  const status = useEgress(client.status);
  const [mode, setMode] = useState<Mode>('edit');
  const projects = useEgress(client.projects);
  const view = useEgress(client.document);
  const [runId, setRunId] = useState<string | null>(null);
  const playback = useMemo(() => (runId ? client.playback(runId) : null), [client, runId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'system-ui, sans-serif', fontSize: 13, background: '#f6f7f9', color: '#1d2330' }}>
      <header style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #d8dce3', background: '#fff' }}>
        <strong>Egress /dev</strong>
        <nav style={{ display: 'flex', gap: 4 }}>
          {(['edit', 'live', 'analysis'] as const).map(m => (
            <button key={m} onClick={() => setMode(m)} style={tab(mode === m)}>{m[0].toUpperCase() + m.slice(1)}</button>
          ))}
        </nav>
        <select value={view.projectId ?? ''} onChange={e => { setRunId(null); void client.openProject(e.target.value || null); }}>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name} (r{p.revision})</option>)}
        </select>
        <select value="" onChange={e => { const f = FIXTURES.find(x => x.name === e.target.value); if (f) { setRunId(null); void client.createProject(f.name, f.doc()); } }}>
          <option value="">+ new project…</option>
          {FIXTURES.map(f => <option key={f.name}>{f.name}</option>)}
        </select>
        <span style={{ color: '#6b7385' }}>{backend === 'local' ? `SpacetimeDB local (${status})` : 'mock backend'} · rev {view.doc?.revision ?? '–'}{view.pending ? ` · ${view.pending} pending` : ''}</span>
        {view.lastError && <span style={{ color: '#b42318' }}>{view.lastError.code}: {view.lastError.message}</span>}
        {view.doc && deriveLayout(view.doc).diagnostics.map((d, i) => <span key={i} title={d.message} style={{ color: d.level === 'error' ? '#b42318' : '#b54708' }}>⚠ {d.code}</span>)}
      </header>
      {mode === 'edit' && <EditMode client={client} />}
      {mode === 'live' && <LiveMode client={client} playback={playback} onRun={setRunId} />}
      {mode === 'analysis' && <AnalysisMode client={client} runId={runId} />}
    </div>
  );
}

// ── Edit ────────────────────────────────────────────────────────────────────

function EditMode({ client }: { client: EgressClient }) {
  const view = useEgress(client.document);
  const [tool, setTool] = useState<Tool>('pen');
  const [chain, setChain] = useState<Vec2[]>([]);
  const [drag, setDrag] = useState<{ from: Vec2; to: Vec2 } | null>(null);
  const [hover, setHover] = useState<Vec2 | null>(null);
  const doc = view.doc;
  const floorId = doc?.floors[0]?.id;
  // Static structural analysis (not a crowd simulation), debounced after edits.
  const [analysis, setAnalysis] = useState<StructuralFieldId | 'off'>('people.routeDemand');
  const [structural, setStructural] = useState<{ field: ScalarField; max: number } | null>(null);
  useEffect(() => {
    const handle = setTimeout(() => {
      if (!doc || analysis === 'off' || !doc.openings.some(o => o.openingKind === 'exit')) { setStructural(null); return; }
      const field = structuralField(compileFloor(doc), analysis);
      let max = 0;
      for (const v of field.values) if (v > max) max = v;
      setStructural({ field, max: max || 1 });
    }, 200);
    return () => clearTimeout(handle);
  }, [doc, analysis]);
  const heat = useMemo(() => (structural ? () => structural.field : undefined), [structural]);

  const commit = (commands: EditCommand[]) => void client.edit(commands);
  const finishChain = () => {
    if (floorId && chain.length >= 2) commit([{ kind: 'createWallChain', floorId, points: chain, ...WALL }]);
    setChain([]);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') finishChain();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); void (e.shiftKey ? client.redo() : client.undo()); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const onPointer = (kind: 'down' | 'move' | 'up', world: Vec2) => {
    const p = doc ? snap(world, doc) : world;
    setHover(p);
    if (!floorId) return;
    if (tool === 'pen' && kind === 'down') setChain(c => [...c, p]);
    if ((tool === 'box' || tool === 'erase') && kind === 'down') setDrag({ from: p, to: p });
    if ((tool === 'box' || tool === 'erase') && kind === 'move' && drag) setDrag({ ...drag, to: p });
    if ((tool === 'box' || tool === 'erase') && kind === 'up' && drag) {
      if (tool === 'box') commit([{ kind: 'createBox', floorId, min: drag.from, max: p, ...WALL }]);
      else commit([{ kind: 'eraseByLine', floorId, from: drag.from, to: p }]);
      setDrag(null);
    }
    if ((tool === 'door' || tool === 'exit' || tool === 'window') && kind === 'down' && doc) {
      const hit = nearestWall(doc, world);
      if (hit) commit([{ kind: 'createOpening', wallId: hit.wallId, openingKind: tool, offsetM: Math.round(hit.offsetM * 4) / 4, widthM: OPENING_WIDTH[tool] }]);
    }
  };

  const overlay = (ctx: CanvasRenderingContext2D, toScreen: (p: Vec2) => Vec2) => {
    ctx.strokeStyle = '#2f6fed'; ctx.setLineDash([6, 4]); ctx.lineWidth = 2;
    const pts = hover && tool === 'pen' ? [...chain, hover] : chain;
    if (pts.length > 1) { ctx.beginPath(); pts.forEach((p, i) => { const s = toScreen(p); if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); }); ctx.stroke(); }
    if (drag) {
      const a = toScreen(drag.from), b = toScreen(drag.to);
      ctx.strokeStyle = tool === 'erase' ? '#d92d20' : '#2f6fed';
      if (tool === 'box') ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      else { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    }
    ctx.setLineDash([]);
  };

  return (
    <>
      <Toolbar>
        {(['pen', 'box', 'erase', 'door', 'exit', 'window'] as const).map(t => (
          <button key={t} style={tab(tool === t)} onClick={() => { finishChain(); setTool(t); }}>{t}</button>
        ))}
        <span style={{ width: 16 }} />
        <button disabled={!view.canUndo} onClick={() => void client.undo()}>Undo</button>
        <button disabled={!view.canRedo} onClick={() => void client.redo()}>Redo</button>
        <span style={{ color: '#6b7385' }}>
          {tool === 'pen' ? 'Click points; Esc/Enter ends the chain.' : tool === 'box' ? 'Drag a rectangle.' : tool === 'erase' ? 'Drag a line across walls to delete them.' : 'Click a wall.'}
          {' '}Snap {CELL_SIZE_M} m.
        </span>
        <label title='Static estimate from the geometry, assuming people start evenly spread. Not observed congestion.'>Estimate <select value={analysis} onChange={e => setAnalysis(e.target.value as typeof analysis)}>
          <option value='people.routeDemand'>potential bottlenecks (route demand)</option><option value='people.exitDistance'>distance to exit</option><option value='off'>off</option>
        </select></label>
      </Toolbar>
      <PlanCanvas doc={doc} onPointer={onPointer} overlay={overlay} heat={heat} heatMax={structural?.max} />
    </>
  );
}

// ── Live ────────────────────────────────────────────────────────────────────

function LiveMode({ client, playback, onRun }: { client: EgressClient; playback: PlaybackController | null; onRun: (id: string) => void }) {
  const view = useEgress(client.document);
  const [count, setCount] = useState(150);
  const [seed, setSeed] = useState(1);
  const [pace, setPace] = useState<Pace>('x1');
  const [heatField, setHeatField] = useState<'people.congestion' | 'people.density' | 'off'>('people.congestion');
  const [heatAgg, setHeatAgg] = useState<Aggregation | 'auto'>('auto');
  const runs = useEgress(client.runs);
  const run = playback ? runs.find(r => r.id === playback.state.get().runId) : undefined;
  const heat = useMemo(() => (heatField === 'off' || !playback ? undefined : () => {
    // Default: Current while running, Average once complete (the last frame is an empty building).
    const agg = heatAgg !== 'auto' ? heatAgg : playback.state.get().complete ? 'timeAverage' : 'instant';
    return playback.field(heatField, agg);
  }), [heatField, heatAgg, playback]);
  // Population paint: relative starting density; never changes N (spec §4).
  const [painting, setPainting] = useState(false);
  const [brush, setBrush] = useState<{ mode: PopulationBrushStroke['mode']; radiusM: number; weight: number }>({ mode: 'increase', radiusM: 1.5, weight: 2 });
  const [strokes, setStrokes] = useState<PopulationBrushStroke[]>([]);
  const [drawing, setDrawing] = useState<Vec2[] | null>(null);
  const floorId = view.doc?.floors[0]?.id;
  const paint = useMemo(() => {
    if (!view.doc || (!painting && !strokes.length)) return null;
    const live = drawing && floorId ? [...strokes, { id: 'draft', floorId, points: drawing, falloff: 'linear' as const, ...brush }] : strokes;
    try {
      const compiled = compileFloor(view.doc);
      return { weights: paintWeights(compiled, live), grid: compiled.grid };
    } catch {
      return null;
    }
  }, [view.doc, painting, strokes, drawing, brush, floorId]);
  const onPaint = (kind: 'down' | 'move' | 'up', p: Vec2) => {
    if (!floorId) return;
    if (kind === 'down') setDrawing([p]);
    else if (kind === 'move' && drawing) {
      const last = drawing[drawing.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) > brush.radiusM / 4) setDrawing([...drawing, p]);
    } else if (kind === 'up' && drawing) {
      setStrokes(list => [...list, { id: `stroke-${list.length}`, floorId, points: drawing, falloff: 'linear', ...brush }]);
      setDrawing(null);
    }
  };
  const start = async () => {
    if (!view.projectId) return;
    setPainting(false);
    const id = await client.startRun({
      scenarioVersion: 1, id: `scn-${Date.now()}`, projectId: view.projectId, name: 'Evacuate', durationSeconds: 300,
      population: { count, distribution: strokes.length ? 'painted' : 'uniform', strokes, seed }, goal: { kind: 'evacuate', blockedExitIds: [] },
    }, pace);
    onRun(id);
    client.playback(id).play();
  };
  return (
    <>
      <Toolbar>
        <label>People <input type="number" min={1} max={2000} value={count} onChange={e => setCount(Number(e.target.value))} style={{ width: 70 }} /></label>
        <label>Seed <input type="number" value={seed} onChange={e => setSeed(Number(e.target.value))} style={{ width: 60 }} /></label>
        <label>Pace <select value={pace} onChange={e => setPace(e.target.value as Pace)}>{(['x1', 'x2', 'x4', 'unpaced'] as const).map(p => <option key={p}>{p}</option>)}</select></label>
        <button onClick={() => setPainting(v => !v)} style={tab(painting)}>Paint{strokes.length ? ` (${strokes.length})` : ''}</button>
        <button onClick={start}>Evacuate</button>
        {playback && <Transport playback={playback} />}
        <label>Heatmap <select value={heatField} onChange={e => setHeatField(e.target.value as typeof heatField)}>
          <option value="people.congestion">congestion</option><option value="people.density">density</option><option value="off">off</option>
        </select></label>
        <select value={heatAgg} onChange={e => setHeatAgg(e.target.value as typeof heatAgg)}>
          <option value="auto">auto</option><option value="instant">current</option><option value="timeAverage">average</option><option value="perCellPeak">peak</option>
        </select>
        {run?.error && <span style={{ color: '#b42318' }}>{run.error.code}: {run.error.message}</span>}
      </Toolbar>
      {painting && <Toolbar>
        <strong style={{ color: '#1570ef' }}>Paint starting density</strong>
        <select value={brush.mode} onChange={e => setBrush({ ...brush, mode: e.target.value as typeof brush.mode })}>
          {(['increase', 'decrease', 'set', 'erase'] as const).map(m => <option key={m}>{m}</option>)}
        </select>
        <label>Radius <input type="number" step={0.25} min={0.25} max={10} value={brush.radiusM} onChange={e => setBrush({ ...brush, radiusM: Number(e.target.value) })} style={{ width: 60 }} /> m</label>
        <label>Weight <input type="number" step={0.5} min={0} max={4} value={brush.weight} onChange={e => setBrush({ ...brush, weight: Number(e.target.value) })} style={{ width: 50 }} /></label>
        <button onClick={() => setStrokes([])}>Reset to uniform</button>
        <span style={{ color: '#6b7385' }}>Blue = where the {count} people are likely to start (initial distribution, not congestion). N stays {count}.</span>
      </Toolbar>}
      <PlanCanvas
        doc={view.doc}
        playback={painting ? null : playback}
        heat={painting ? undefined : heat}
        paint={painting || !playback ? paint : null}
        onPointer={painting ? onPaint : undefined}
        overlay={painting ? (ctx, toScreen) => drawBrush(ctx, toScreen, drawing, brush.radiusM) : undefined}
      />
      {playback && <Scrubber playback={playback} />}
    </>
  );
}

function Transport({ playback }: { playback: PlaybackController }) {
  const s = useEgress(playback.state);
  const m = useEgress(playback.metrics);
  return (
    <>
      <button onClick={() => playback.skip(-10)}>« 10</button>
      <button onClick={() => playback.toggle()} style={{ minWidth: 60 }}>{s.playing ? 'Pause' : 'Play'}</button>
      <button onClick={() => playback.skip(10)}>10 »</button>
      <span>t = {(s.tick / TICK_RATE_HZ).toFixed(1)} s · {s.actorCount} people · {s.status}</span>
      {m && <span style={{ color: '#6b7385' }}>evacuated {m.evacuatedPeople}/{m.initialPeople} · max queue {m.maxQueueLength}{m.evacuationTimeSeconds != null ? ` · done in ${m.evacuationTimeSeconds.toFixed(1)} s` : ''}</span>}
    </>
  );
}

function Scrubber({ playback }: { playback: PlaybackController }) {
  const s = useEgress(playback.state);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: '#fff', borderTop: '1px solid #d8dce3' }}>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{(s.tick / TICK_RATE_HZ).toFixed(1)} s</span>
      <input type="range" min={0} max={Math.max(1, s.liveTick)} step={1} value={s.tick} onChange={e => playback.seek(Number(e.target.value))} style={{ flex: 1 }} />
      <button onClick={() => playback.goLive()} style={{ ...tab(s.atLiveEdge), color: s.complete ? '#344054' : '#d92d20', fontWeight: 700 }}>
        {s.complete ? 'END' : '● LIVE'}
      </button>
      <span style={{ fontVariantNumeric: 'tabular-nums', color: '#6b7385' }}>{(s.liveTick / TICK_RATE_HZ).toFixed(1)} s</span>
    </div>
  );
}

// ── Analysis ────────────────────────────────────────────────────────────────

function AnalysisMode({ client, runId }: { client: EgressClient; runId: string | null }) {
  const view = useEgress(client.document);
  const steps = useEgress(client.agentSteps);
  const jobs = useEgress(client.agentJobs);
  const proposals = useEgress(client.proposals);
  const [prompt, setPrompt] = useState('Investigate the worst bottleneck and suggest one change.');
  const open = proposals.filter(p => p.status === 'proposed');
  return (
    <>
      <Toolbar>
        <form style={{ display: 'flex', gap: 8, flex: 1 }} onSubmit={e => { e.preventDefault(); if (prompt.trim()) void client.askAgent(prompt, runId ? { runId } : {}); }}>
          <input value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Ask the agent…" style={{ flex: 1, padding: '4px 8px' }} />
          <button type="submit">Ask</button>
        </form>
      </Toolbar>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <PlanCanvas doc={view.doc} ghosts={open} />
        <aside style={{ width: 340, overflow: 'auto', borderLeft: '1px solid #d8dce3', background: '#fff', padding: 8 }}>
          {steps.map(s => (
            <div key={s.id} style={{ border: '1px solid #e4e7ec', borderRadius: 6, padding: 6, marginBottom: 6 }}>
              <div style={{ fontWeight: 600 }}>{s.kind}{s.toolName ? ` · ${s.toolName}` : ''}</div>
              <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 11, maxHeight: 120, overflow: 'auto' }}>{s.kind === 'message' ? String((s.payload as { text?: string }).text ?? '') : JSON.stringify(s.payload, null, 1).slice(0, 1500)}</pre>
            </div>
          ))}
          {jobs.map(j => (
            <div key={j.id} style={{ fontSize: 12, color: j.status === 'failed' ? '#b42318' : '#344054', marginBottom: 6 }}>
              <strong>{j.status === 'running' ? 'Agent is working…' : j.status === 'failed' ? 'Agent failed' : 'Agent finished'}</strong>{j.summary ? ` — ${j.summary}` : ''}
            </div>
          ))}
          {proposals.map(p => (
            <div key={p.id} style={{ border: '1px solid #b692f6', borderRadius: 6, padding: 6, marginBottom: 6, background: '#f9f5ff' }}>
              <div style={{ fontWeight: 600 }}>Proposal · {p.status}</div>
              <div>{p.notes.summary}</div>
              <div style={{ color: '#6b7385' }}>{Object.entries(p.delta).map(([k, v]) => `${k}: ${v > 0 ? '+' : ''}${v}`).join(' · ')}</div>
              {p.status === 'proposed' && (
                <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                  <button onClick={() => void client.acceptProposal(p.id)}>Accept</button>
                  <button onClick={() => void client.rejectProposal(p.id)}>Reject</button>
                </div>
              )}
            </div>
          ))}
        </aside>
      </div>
    </>
  );
}

// ── Plan canvas ─────────────────────────────────────────────────────────────

function PlanCanvas({ doc, onPointer, overlay, playback, ghosts, heat, heatMax = 4, paint }: {
  doc: EgressDocument | null;
  onPointer?: (kind: 'down' | 'move' | 'up', world: Vec2) => void;
  overlay?: (ctx: CanvasRenderingContext2D, toScreen: (p: Vec2) => Vec2) => void;
  playback?: PlaybackController | null;
  ghosts?: ProposalView[];
  heat?: () => ScalarField | null;
  /** Value that maps to full colour. */
  heatMax?: number;
  /** Painted relative starting density (0–4 per cell). */
  paint?: { weights: Float32Array; grid: ScalarField['grid'] } | null;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const transform = useRef({ scale: 30, ox: 40, oy: 40, h: 600 });
  const draw = useRef<() => void>(() => {});

  // Refresh the draw closure after every render; the RAF loop below always calls the latest one.
  useEffect(() => { draw.current = () => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const { clientWidth: w, clientHeight: h } = el;
    if (el.width !== w * devicePixelRatio) { el.width = w * devicePixelRatio; el.height = h * devicePixelRatio; }
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const bounds = docBounds(doc);
    const scale = Math.min((w - 80) / bounds.w, (h - 80) / bounds.h);
    transform.current = { scale, ox: 40 - bounds.x0 * scale + (w - 80 - bounds.w * scale) / 2, oy: 40 + bounds.y1 * scale + (h - 80 - bounds.h * scale) / 2, h };
    const toScreen = (p: Vec2): Vec2 => ({ x: transform.current.ox + p.x * scale, y: transform.current.oy - p.y * scale });

    // grid
    ctx.strokeStyle = '#e8ebf0'; ctx.lineWidth = 1;
    for (let x = Math.floor(bounds.x0); x <= bounds.x0 + bounds.w; x++) { const a = toScreen({ x, y: bounds.y0 }), b = toScreen({ x, y: bounds.y1 }); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    for (let y = Math.floor(bounds.y0); y <= bounds.y1; y++) { const a = toScreen({ x: bounds.x0, y }), b = toScreen({ x: bounds.x0 + bounds.w, y }); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }

    if (doc) drawDoc(ctx, doc, toScreen, scale, {});
    for (const g of ghosts ?? []) if (g.ghost) drawGhost(ctx, doc, g, toScreen, scale);

    if (paint) {
      const { origin, cellSizeM: cs, width } = paint.grid;
      for (let i = 0; i < paint.weights.length; i++) {
        const w = paint.weights[i];
        if (!(w > 0)) continue;
        const cx = i % width, cy = (i - cx) / width;
        const s = toScreen({ x: origin.x + cx * cs, y: origin.y + (cy + 1) * cs });
        ctx.fillStyle = `rgba(21, 112, 239, ${0.08 + 0.6 * (w / 4)})`;
        ctx.fillRect(s.x, s.y, cs * scale + 0.5, cs * scale + 0.5);
      }
    }
    const field = heat?.();
    if (field) {
      // Sequential ramp: transparent → amber → red. Congestion and density both saturate around 4.
      const { origin, cellSizeM: cs, width } = field.grid;
      for (let i = 0; i < field.values.length; i++) {
        const v = field.values[i];
        if (!(v > 0.05)) continue;
        const t = Math.min(1, v / heatMax);
        const cx = i % width, cy = (i - cx) / width;
        const s = toScreen({ x: origin.x + cx * cs, y: origin.y + (cy + 1) * cs });
        ctx.fillStyle = `rgba(${Math.round(250 - 30 * t)}, ${Math.round(190 - 160 * t)}, ${Math.round(60 - 30 * t)}, ${0.25 + 0.55 * t})`;
        ctx.fillRect(s.x, s.y, cs * scale + 0.5, cs * scale + 0.5);
      }
    }
    const actors = playback?.actorsNow();
    if (actors) {
      for (let i = 0; i < actors.actorFlags.length; i++) {
        if (actors.actorFlags[i] === ACTOR_EXITED) continue;
        const s = toScreen({ x: actors.actorXY[i * 2], y: actors.actorXY[i * 2 + 1] });
        ctx.fillStyle = actors.actorFlags[i] === ACTOR_QUEUED ? '#d92d20' : '#1570ef';
        ctx.beginPath(); ctx.arc(s.x, s.y, Math.max(2, 0.22 * scale), 0, Math.PI * 2); ctx.fill();
      }
    }
    overlay?.(ctx, toScreen);
  }; });

  useEffect(() => {
    let raf = 0;
    const loop = () => { draw.current(); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const world = (e: React.PointerEvent): Vec2 => {
    const r = canvas.current!.getBoundingClientRect();
    const { scale, ox, oy } = transform.current;
    return { x: (e.clientX - r.left - ox) / scale, y: (oy - (e.clientY - r.top)) / scale };
  };

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative' }}>
      <canvas
        ref={canvas}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', cursor: onPointer ? 'crosshair' : 'default', background: '#fbfcfd' }}
        onPointerDown={e => onPointer?.('down', world(e))}
        onPointerMove={e => onPointer?.('move', world(e))}
        onPointerUp={e => onPointer?.('up', world(e))}
      />
    </div>
  );
}

function drawDoc(ctx: CanvasRenderingContext2D, doc: EgressDocument, toScreen: (p: Vec2) => Vec2, scale: number, style: { color?: string; dash?: number[]; only?: Set<string> }) {
  const { walls, topology } = deriveLayout(doc);
  const path = (polygon: Vec2[]) => {
    ctx.beginPath();
    polygon.forEach((p, i) => { const s = toScreen(p); if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); });
    ctx.closePath();
  };
  if (!style.only) {
    ctx.fillStyle = '#eef2f7';
    for (const room of topology.rooms) { path(room.polygon); ctx.fill(); }
  }
  const material = new Map(doc.walls.map(w => [w.id, w.material]));
  ctx.setLineDash(style.dash ?? []);
  for (const piece of walls.pieces) {
    if (style.only && !style.only.has(piece.wallId)) continue;
    path(piece.polygon);
    if (style.only) { ctx.strokeStyle = style.color ?? '#9e77ed'; ctx.lineWidth = 1.5; ctx.stroke(); continue; }
    const m = material.get(piece.wallId);
    ctx.fillStyle = m === 'glass' ? '#9fd3ee' : m === 'reinforced' ? '#2e323b' : '#5b6270';
    ctx.fill();
  }
  if (!style.only) {
    ctx.fillStyle = '#5b6270';
    for (const hub of walls.hubs) { path(hub.polygon); ctx.fill(); }
  }
  ctx.lineCap = 'butt';
  for (const o of doc.openings) {
    if (style.only && !style.only.has(o.id)) continue;
    const seg = openingSegment(doc, o.id);
    if (!seg) continue;
    const a = toScreen(seg.a), b = toScreen(seg.b);
    ctx.strokeStyle = style.color ?? (o.openingKind === 'exit' ? '#12b76a' : o.openingKind === 'door' ? '#b54708' : '#53b1fd');
    ctx.lineWidth = o.openingKind === 'exit' ? 5 : 3;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.setLineDash([]);
}

function drawGhost(ctx: CanvasRenderingContext2D, current: EgressDocument | null, p: ProposalView, toScreen: (p: Vec2) => Vec2, scale: number) {
  const ghost = p.ghost!;
  const touched = new Set([...ghost.createdIds.flat(), ...ghost.changedIds]);
  drawDoc(ctx, ghost.doc, toScreen, scale, { color: '#9e77ed', dash: [5, 4], only: touched });
  // One "why" bubble per command, anchored on what it created or changed.
  p.commands.forEach((command, i) => {
    const note = p.notes.byCommand[String(i)];
    if (!note) return;
    const id = ghost.createdIds[i]?.[0] ?? targetId(command);
    const anchor = id ? entityCenter(ghost.doc, id) ?? (current ? entityCenter(current, id) : null) : null;
    if (!anchor) return;
    const s = toScreen(anchor);
    ctx.font = '12px system-ui';
    const text = note.length > 70 ? `${note.slice(0, 67)}…` : note;
    const width = ctx.measureText(text).width + 12;
    ctx.fillStyle = '#f4ebff'; ctx.strokeStyle = '#9e77ed'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(s.x + 10, s.y - 30, width, 22, 6); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#42307d'; ctx.fillText(text, s.x + 16, s.y - 15);
  });
}

// ── geometry helpers for the harness ──

function drawBrush(ctx: CanvasRenderingContext2D, toScreen: (p: Vec2) => Vec2, points: Vec2[] | null, radiusM: number) {
  if (!points?.length) return;
  const r = Math.abs(toScreen({ x: radiusM, y: 0 }).x - toScreen({ x: 0, y: 0 }).x);
  const p = toScreen(points[points.length - 1]);
  ctx.strokeStyle = 'rgba(21, 112, 239, 0.9)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
}

function targetId(c: EditCommand): string | null {
  return 'openingId' in c ? c.openingId : 'wallId' in c ? c.wallId : 'vertexId' in c ? c.vertexId : null;
}

function openingSegment(doc: EgressDocument, openingId: string) {
  const o = doc.openings.find(x => x.id === openingId);
  const w = o && doc.walls.find(x => x.id === o.wallId);
  const a = w && doc.vertices.find(v => v.id === w.startVertexId)?.position;
  const b = w && doc.vertices.find(v => v.id === w.endVertexId)?.position;
  if (!o || !a || !b) return null;
  const len = Math.hypot(b.x - a.x, b.y - a.y), dx = (b.x - a.x) / len, dy = (b.y - a.y) / len;
  return {
    a: { x: a.x + dx * (o.offsetM - o.widthM / 2), y: a.y + dy * (o.offsetM - o.widthM / 2) },
    b: { x: a.x + dx * (o.offsetM + o.widthM / 2), y: a.y + dy * (o.offsetM + o.widthM / 2) },
  };
}

function entityCenter(doc: EgressDocument, id: string): Vec2 | null {
  const seg = openingSegment(doc, id);
  if (seg) return { x: (seg.a.x + seg.b.x) / 2, y: (seg.a.y + seg.b.y) / 2 };
  const w = doc.walls.find(x => x.id === id);
  if (w) {
    const a = doc.vertices.find(v => v.id === w.startVertexId)!.position, b = doc.vertices.find(v => v.id === w.endVertexId)!.position;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  return doc.vertices.find(v => v.id === id)?.position ?? null;
}

function nearestWall(doc: EgressDocument, p: Vec2): { wallId: string; offsetM: number } | null {
  let best: { wallId: string; offsetM: number; d: number } | null = null;
  for (const w of doc.walls) {
    const a = doc.vertices.find(v => v.id === w.startVertexId)!.position, b = doc.vertices.find(v => v.id === w.endVertexId)!.position;
    const hit = projectOnSegment(p, a, b);
    if (hit.distance < 0.6 && (!best || hit.distance < best.d)) best = { wallId: w.id, offsetM: hit.t * Math.hypot(b.x - a.x, b.y - a.y), d: hit.distance };
  }
  return best;
}

function snap(p: Vec2, doc: EgressDocument): Vec2 {
  for (const v of doc.vertices) if (Math.hypot(v.position.x - p.x, v.position.y - p.y) < 0.3) return v.position;
  return { x: Math.round(p.x / CELL_SIZE_M) * CELL_SIZE_M, y: Math.round(p.y / CELL_SIZE_M) * CELL_SIZE_M };
}

function docBounds(doc: EgressDocument | null) {
  const xs = doc?.vertices.map(v => v.position.x) ?? [], ys = doc?.vertices.map(v => v.position.y) ?? [];
  if (!xs.length) return { x0: -1, y0: -1, y1: 11, w: 16, h: 12 };
  const x0 = Math.min(...xs) - 2, x1 = Math.max(...xs) + 2, y0 = Math.min(...ys) - 2, y1 = Math.max(...ys) + 2;
  return { x0, y0, y1, w: Math.max(4, x1 - x0), h: Math.max(4, y1 - y0) };
}

function Toolbar({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 12px', background: '#fff', borderBottom: '1px solid #d8dce3', flexWrap: 'wrap' }}>{children}</div>;
}

const tab = (active: boolean): React.CSSProperties => ({
  padding: '3px 10px', borderRadius: 6, border: '1px solid ' + (active ? '#2f6fed' : '#d0d5dd'), background: active ? '#eef4ff' : '#fff', cursor: 'pointer',
});
