'use client';
/**
 * Escape plans (PLAN.md §3 E, D73): one plan per real room. Hallways, stairs and closets get
 * none. Each shows the floor in black on white, the room, "You are here", the primary route
 * to the best exit and a secondary route through a different exit.
 */
import { useMemo, useRef } from 'react';
import { ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import { deriveLayout, describeRooms, PLANNED_ROOM_KINDS, type EgressDocument, type RoomLabel, type Vec2 } from '@egress/core';
import { compileFloor, escapeRoutes, type EscapeRoute } from '@egress/sim';

interface Plan { hash: string; name: string; polygon: Vec2[]; center: Vec2; primary: EscapeRoute | null; secondary: EscapeRoute | null }

export function buildPlans(doc: EgressDocument, labels: ReadonlyMap<string, RoomLabel>): Plan[] {
  let compiled: ReturnType<typeof compileFloor>;
  try { compiled = compileFloor(doc); } catch { return []; }
  return describeRooms(doc).flatMap(room => {
    const label = labels.get(room.roomHash);
    const kind = label?.kind ?? room.ruleKind;
    if (!PLANNED_ROOM_KINDS.includes(kind)) return [];
    const routes = escapeRoutes(doc, room.center, room.polygon, compiled);
    const primary = routes[0] ?? null;
    const secondary = routes.find(r => r.exitId !== primary?.exitId) ?? null;
    return [{ hash: room.roomHash, name: label?.name ?? 'Room', polygon: room.polygon, center: room.center, primary, secondary }];
  });
}

export default function EscapePlans({ doc, labels, projectName }: { doc: EgressDocument; labels: ReadonlyMap<string, RoomLabel>; projectName: string }) {
  const plans = useMemo(() => buildPlans(doc, labels), [doc, labels]);
  if (!plans.length) return <p className="empty">No rooms to plan for yet. Escape plans cover rooms, not hallways, stairs or closets, and need at least one exit.</p>;
  return <div className="plans">{plans.map(p => <PlanCard key={p.hash} doc={doc} plan={p} projectName={projectName} />)}</div>;
}

function PlanCard({ doc, plan, projectName }: { doc: EgressDocument; plan: Plan; projectName: string }) {
  const svg = useRef<SVGSVGElement>(null);
  const derived = deriveLayout(doc);
  const pts = [...derived.walls.pieces.flatMap(p => p.polygon), ...derived.walls.hubs.flatMap(h => h.polygon)];
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = Math.max(maxX - minX, maxY - minY) * 0.06 + 0.5;
  const X = (x: number) => x - minX + pad, Y = (y: number) => maxY - y + pad;
  const d = (poly: Vec2[]) => `M${poly.map(p => `${X(p.x).toFixed(3)} ${Y(p.y).toFixed(3)}`).join('L')}Z`;
  const line = (path: Vec2[]) => path.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(3)} ${Y(p.y).toFixed(3)}`).join('');
  const w = maxX - minX + pad * 2, h = maxY - minY + pad * 2, s = Math.max(w, h) / 60;
  const exits = doc.openings.filter(o => o.openingKind === 'exit');
  const vertices = new Map(doc.vertices.map(v => [v.id, v.position]));
  const download = () => {
    const el = svg.current; if (!el) return;
    const xml = new XMLSerializer().serializeToString(el);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = Math.round(1600 * h / w);
      const g = canvas.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height); g.drawImage(img, 0, 0, canvas.width, canvas.height);
      const a = document.createElement('a'); a.download = `${projectName} - ${plan.name} escape plan.png`.replace(/[^\w\- .]+/g, ''); a.href = canvas.toDataURL('image/png'); a.click();
    };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  };
  return <article className="plan-card">
    <header><h3>{plan.name}</h3><button className="icon-button" aria-label={`Download the ${plan.name} plan`} data-tip="Download PNG" onClick={download}><ArrowDownTrayIcon /></button></header>
    <svg ref={svg} xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Escape plan for ${plan.name}`}>
      <rect width={w} height={h} fill="#fff" />
      <path d={d(plan.polygon)} fill="#dbeafe" />
      {derived.walls.pieces.map((p, i) => <path key={`p${i}`} d={d(p.polygon)} fill="#000" />)}
      {derived.walls.hubs.map((hub, i) => <path key={`h${i}`} d={d(hub.polygon)} fill="#000" />)}
      {plan.secondary && <path d={line(plan.secondary.path)} fill="none" stroke="#15803d" strokeWidth={s * 0.9} strokeDasharray={`${s * 2} ${s * 1.4}`} strokeLinejoin="round" strokeLinecap="round" />}
      {plan.primary && <path d={line(plan.primary.path)} fill="none" stroke="#15803d" strokeWidth={s * 1.5} strokeLinejoin="round" strokeLinecap="round" />}
      {exits.map(o => {
        const wall = doc.walls.find(x => x.id === o.wallId); if (!wall) return null;
        const a = vertices.get(wall.startVertexId)!, b = vertices.get(wall.endVertexId)!, len = Math.hypot(b.x - a.x, b.y - a.y);
        const c = { x: a.x + (b.x - a.x) * o.offsetM / len, y: a.y + (b.y - a.y) * o.offsetM / len };
        return <g key={o.id}><rect x={X(c.x) - s * 2.4} y={Y(c.y) - s * 1.1} width={s * 4.8} height={s * 2.2} rx={s * 0.4} fill="#15803d" /><text x={X(c.x)} y={Y(c.y) + s * 0.55} fontSize={s * 1.4} fill="#fff" textAnchor="middle" fontFamily="Arial, sans-serif" fontWeight="700">EXIT</text></g>;
      })}
      <circle cx={X(plan.center.x)} cy={Y(plan.center.y)} r={s * 1.2} fill="#dc2626" stroke="#fff" strokeWidth={s * 0.3} />
      <text x={X(plan.center.x)} y={Y(plan.center.y) - s * 2} fontSize={s * 1.5} fill="#dc2626" textAnchor="middle" fontFamily="Arial, sans-serif" fontWeight="700">You are here</text>
    </svg>
    <dl className="details">
      <div><dt>Primary route</dt><dd>{plan.primary ? `${plan.primary.distanceM} m · about ${plan.primary.seconds} s` : 'No exit reachable'}</dd></div>
      <div><dt>Secondary route</dt><dd>{plan.secondary ? `${plan.secondary.distanceM} m · about ${plan.secondary.seconds} s` : '-'}</dd></div>
    </dl>
  </article>;
}
