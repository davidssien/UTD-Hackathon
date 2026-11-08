'use client';
/**
 * The saves page: Egress's landing page (PLAN.md §3 B). A full-page list of your projects
 * with size and JSON download, and the selected project's plan (black on white) and
 * details. Open (or double-click) slides this page away to reveal the editor.
 */
import Image from 'next/image';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownTrayIcon, ChevronDownIcon, DocumentArrowUpIcon, EllipsisHorizontalIcon, PencilSquareIcon, PhotoIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/outline';
import type { EgressClient, ProjectStats, ProjectSummary } from '@egress/client';
import { useEgress } from '@egress/client/react';
import { deriveLayout, type EgressDocument } from '@egress/core';
import { EXAMPLES, type ExampleSave } from '@/lib/examples';

interface Props {
  pageRef: React.Ref<HTMLElement>;
  client: EgressClient;
  active: boolean;
  onOpen(projectId: string): void;
  onImportImage(): void;
  /** Creates a new project from an example save; resolves to its id. */
  onCreateExample(example: ExampleSave): Promise<string>;
  onError(e: unknown): void;
}

const kb = (bytes: number | undefined) => (bytes === undefined ? '—' : `${(bytes / 1024).toFixed(1)} KB`);
const when = (ms: number) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function downloadJson(name: string, doc: EgressDocument) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = `${name.replace(/[^\w\- ]+/g, '').trim() || 'egress-plan'}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function SavesPage({ pageRef, client, active, onOpen, onImportImage, onCreateExample, onError }: Props) {
  const projects = useEgress(client.projects), stats = useEgress(client.projectStats), view = useEgress(client.document), status = useEgress(client.status);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; doc: EgressDocument } | null>(null);
  const [failedPreview, setFailedPreview] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [examplesOpen, setExamplesOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const byId = useMemo(() => new Map(stats.map(s => [s.projectId, s])), [stats]);
  const sorted = [...projects].sort((a, b) => b.updatedAt - a.updatedAt);
  const owned = sorted.filter(p => p.role === 'owner'), shared = sorted.filter(p => p.role !== 'owner');
  const current = selected && projects.some(p => p.id === selected) ? selected : view.projectId ?? sorted[0]?.id ?? null;
  const project = projects.find(p => p.id === current) ?? null;
  const projectStats = current ? byId.get(current) : undefined;

  // Load the selected project's document for the plan and details, without opening it.
  const revision = project?.revision;
  const openDoc = view.doc?.projectId === current && view.doc?.revision === revision ? view.doc : null;
  const plan = openDoc ?? (preview?.id === current ? preview.doc : null);
  const loading = status === 'connecting' || (status === 'connected' && !!current && !plan && failedPreview !== current);
  const [splash, setSplash] = useState<'loading' | 'fading' | 'done'>(() => active && loading ? 'loading' : 'done');
  const splashStarted = useRef(0);
  useEffect(() => {
    if (splash !== 'loading') return;
    if (!splashStarted.current) splashStarted.current = performance.now();
    if (loading) return;
    const timer = setTimeout(() => setSplash('fading'), Math.max(0, 500 - (performance.now() - splashStarted.current)));
    return () => clearTimeout(timer);
  }, [loading, splash]);
  useEffect(() => {
    if (!current || !active || openDoc || status !== 'connected') return;
    let live = true;
    client.previewProject(current).then(doc => { if (live) { setPreview({ id: current, doc }); setFailedPreview(null); } }).catch(e => { if (live) { setFailedPreview(current); onError(e); } });
    return () => { live = false; };
  }, [client, current, revision, active, openDoc, status]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    void client.createProject(name.trim() || 'Untitled plan').then(id => { setName(''); setSelected(id); }).catch(onError);
  };
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('That file is larger than 20 MB.');
      const id = await client.importProject(file.name.replace(/\.json$/i, '') || 'Imported plan', await file.text());
      setSelected(id);
    } catch (e) { onError(e); }
  };
  const download = async (p: ProjectSummary) => {
    setMenu(null);
    try { downloadJson(p.name, p.id === current && plan ? plan : await client.previewProject(p.id)); } catch (e) { onError(e); }
  };
  const remove = async (p: ProjectSummary) => {
    setMenu(null);
    if (!confirm(`Delete "${p.name}" and all of its runs? This cannot be undone.`)) return;
    try { await client.deleteProject(p.id); if (selected === p.id) setSelected(null); } catch (e) { onError(e); }
  };

  const row = (p: ProjectSummary) => <tr key={p.id} className={p.id === current ? 'selected' : ''} onClick={() => setSelected(p.id)} onDoubleClick={() => onOpen(p.id)}>
    <td className="name">
      {renaming === p.id
        ? <input autoFocus defaultValue={p.name} maxLength={80} aria-label="Project name" onClick={e => e.stopPropagation()}
          onBlur={e => { const v = e.target.value.trim(); setRenaming(null); if (v && v !== p.name) void client.renameProject(p.id, v).catch(onError); }}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }} />
        : <span>{p.name}</span>}
      {p.id === view.projectId && <em>Open</em>}
    </td>
    <td className="role">{p.role}</td>
    <td className="num">{kb(byId.get(p.id)?.sizeBytes)}</td>
    <td className="num">{when(p.updatedAt)}</td>
    <td className="actions" onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
      <button className="icon-button" aria-label={`Download ${p.name} as JSON`} data-tip="Download JSON" onClick={() => void download(p)}><ArrowDownTrayIcon /></button>
      <span className="row-menu">
        <button className="icon-button" aria-label={`More actions for ${p.name}`} aria-expanded={menu === p.id} onClick={() => setMenu(m => (m === p.id ? null : p.id))}><EllipsisHorizontalIcon /></button>
        {menu === p.id && <div className="menu">
          <button disabled={p.role === 'viewer'} onClick={() => { setMenu(null); setRenaming(p.id); }}><PencilSquareIcon />Rename</button>
          <button className="danger" disabled={p.role !== 'owner'} onClick={() => void remove(p)}><TrashIcon />Delete</button>
        </div>}
      </span>
    </td>
  </tr>;

  return <section ref={pageRef} className={`saves ${active ? 'shown' : 'hidden'}`} aria-label="Saves" aria-hidden={!active} inert={!active}
    onKeyDown={e => { if (e.key === 'Escape') { setMenu(null); setExamplesOpen(false); } }}
    onPointerDownCapture={e => {
      const target = e.target as Element;
      if (!target.closest('.row-menu')) setMenu(null);
      if (!target.closest('.examples-anchor')) setExamplesOpen(false);
    }}>
    {splash !== 'done' && <div className={`saves-splash ${splash}`} role="status"
      onAnimationEnd={() => { if (splash === 'fading') setSplash('done'); }}>
      <div><EgressLogo /><p>{status === 'connecting' ? 'Loading saves…' : loading ? 'Loading project preview…' : status === 'connected' ? 'Saves ready' : 'Saves unavailable'}</p></div>
    </div>}
    <header className="saves-header" inert={splash !== 'done'}>
      <EgressLogo />
      <div className="saves-actions">
        <form onSubmit={create} className="new-project">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="New project name" aria-label="New project name" maxLength={80} />
          <button className="button primary" type="submit" disabled={status !== 'connected'}><PlusIcon />New</button>
        </form>
        <span className="examples-anchor">
          <button className="button" aria-expanded={examplesOpen} onClick={() => setExamplesOpen(v => !v)} disabled={status !== 'connected'}><PlusIcon />Example<ChevronDownIcon /></button>
          {examplesOpen && <div className="menu examples-menu" role="menu">
            {EXAMPLES.map(x => <button key={x.id} role="menuitem" onClick={() => { setExamplesOpen(false); void onCreateExample(x).then(setSelected).catch(onError); }}>
              <span className="example-name">{x.name}</span><span className="example-note">{x.note} · about {x.people} people</span>
            </button>)}
          </div>}
        </span>
        <button className="button" onClick={() => fileInput.current?.click()} disabled={status !== 'connected'}><DocumentArrowUpIcon />Import JSON</button>
        <button className="button" onClick={onImportImage} disabled={status !== 'connected'}><PhotoIcon />Import image</button>
        <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={e => { void importFile(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
    </header>
    <div className="saves-body" inert={splash !== 'done'}>
      <div className="saves-list">
        <table>
          <thead><tr><th>Name</th><th>Role</th><th className="num">Size</th><th className="num">Edited</th><th /></tr></thead>
          <tbody>
            {owned.length > 0 && <tr className="group"><td colSpan={5}>Owned</td></tr>}
            {owned.map(row)}
            {shared.length > 0 && <tr className="group"><td colSpan={5}>Shared with you</td></tr>}
            {shared.map(row)}
          </tbody>
        </table>
        {!projects.length && <p className="empty">{status === 'connected' ? 'No projects yet.' : 'Saves unavailable.'}</p>}
      </div>
      <aside className="saves-detail" aria-label="Project details">
        {project ? <>
          <div className="plan-frame">{plan ? <PlanImage doc={plan} /> : <span className="plan-placeholder">{failedPreview === project.id ? 'Preview unavailable' : 'Loading plan…'}</span>}</div>
          <h2>{project.name}</h2>
          <Details stats={projectStats} project={project} />
          <div className="detail-actions">
            <button className="button" onClick={() => void download(project)}><ArrowDownTrayIcon />Download JSON</button>
            <button className="button primary" onClick={() => onOpen(project.id)}>Open</button>
          </div>
        </> : <p className="empty">Create or import a project to begin.</p>}
      </aside>
    </div>
  </section>;
}

function EgressLogo() {
  return <Image className="egress-logo" src="/Egress-icon.webp" alt="Egress" width={120} height={40} unoptimized loading="eager" />;
}

function Details({ stats, project }: { stats: ProjectStats | undefined; project: ProjectSummary }) {
  const rows: [string, string][] = [
    ['Floors', stats ? String(stats.floors) : '—'],
    ['Walls', stats ? String(stats.walls) : '—'],
    ['Doors · windows · exits', stats ? `${stats.doors} · ${stats.windows} · ${stats.exits}` : '—'],
    ['Size', kb(stats?.sizeBytes)],
    ['Your role', project.role],
    ['Members', stats ? String(stats.members) : '—'],
    ['Last edited', when(project.updatedAt)],
    ['Last evacuation', stats?.lastEvacuationSeconds != null ? `${stats.lastEvacuationSeconds.toFixed(1)} s` : '—'],
  ];
  return <dl className="details">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

/** The floor plan in black on white, from the same wall polygons the 3D scene extrudes. */
function PlanImage({ doc }: { doc: EgressDocument }) {
  const derived = useMemo(() => deriveLayout(doc), [doc]);
  const points = [...derived.walls.pieces.flatMap(p => p.polygon), ...derived.walls.hubs.flatMap(h => h.polygon)];
  if (!points.length) return <span className="plan-placeholder">No walls yet</span>;
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = Math.max(maxX - minX, maxY - minY) * 0.06 + 0.5;
  const d = (poly: { x: number; y: number }[]) => `M${poly.map(p => `${(p.x - minX + pad).toFixed(3)} ${(maxY - p.y + pad).toFixed(3)}`).join('L')}Z`;
  const exits = doc.openings.filter(o => o.openingKind === 'exit');
  const vertices = new Map(doc.vertices.map(v => [v.id, v.position]));
  return <svg viewBox={`0 0 ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`} role="img" aria-label="Floor plan">
    {derived.walls.pieces.map((p, i) => <path key={`p${i}`} d={d(p.polygon)} />)}
    {derived.walls.hubs.map((h, i) => <path key={`h${i}`} d={d(h.polygon)} />)}
    {exits.map(o => {
      const wall = doc.walls.find(w => w.id === o.wallId); if (!wall) return null;
      const a = vertices.get(wall.startVertexId)!, b = vertices.get(wall.endVertexId)!, len = Math.hypot(b.x - a.x, b.y - a.y);
      const c = { x: a.x + (b.x - a.x) * o.offsetM / len, y: a.y + (b.y - a.y) * o.offsetM / len };
      return <circle key={o.id} className="exit" cx={c.x - minX + pad} cy={maxY - c.y + pad} r={Math.max(0.25, o.widthM * 0.35)} />;
    })}
  </svg>;
}
