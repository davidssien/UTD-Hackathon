'use client';
/**
 * Wind compass for the airflow layer: drag the marker around the rim to set the bearing the wind
 * comes from (any of 360°). Arrow keys step 5° (15° with Shift). The airflow is recomputed when
 * the marker is released, not on every move.
 */
import { useRef, useState, type PointerEvent } from 'react';
import { windLabel } from '@egress/sim';

const C = 60, R = 46;
const at = (deg: number, r: number) => ({ x: C + r * Math.sin((deg * Math.PI) / 180), y: C - r * Math.cos((deg * Math.PI) / 180) });
const TICKS = Array.from({ length: 36 }, (_, i) => i * 10);
const SIDES: [string, number][] = [['N', 0], ['E', 90], ['S', 180], ['W', 270]];

export default function WindCompass({ value, onChange }: { value: number; onChange(bearing: number): void }) {
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? value;
  const bearingAt = (e: PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    return (Math.round((Math.atan2(dx, -dy) * 180) / Math.PI) + 360) % 360;
  };
  const rim = at(shown, R), inner = at(shown, R - 30);
  const head = [at(shown, R - 30), at(shown + 9, R - 22), at(shown - 9, R - 22)];
  return <div className="wind-compass">
    <svg ref={svg} viewBox="0 0 120 120" role="slider" tabIndex={0} aria-label="Wind from (compass bearing)"
      aria-valuemin={0} aria-valuemax={359} aria-valuenow={shown} aria-valuetext={`From ${windLabel(shown)}`}
      onPointerDown={e => { try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* capture is a convenience */ } setDrag(bearingAt(e)); }}
      onPointerMove={e => { if (drag !== null) setDrag(bearingAt(e)); }}
      onPointerUp={e => { if (drag !== null) { onChange(bearingAt(e)); setDrag(null); } }}
      onPointerCancel={() => setDrag(null)}
      onKeyDown={e => {
        const step = e.shiftKey ? 15 : 5;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); onChange((value + step) % 360); }
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); onChange((value - step + 360) % 360); }
      }}>
      <circle cx={C} cy={C} r={R} className="rim" />
      {TICKS.map(d => { const major = d % 90 === 0, mid = d % 30 === 0, a = at(d, R), b = at(d, R - (major ? 8 : mid ? 5 : 3));
        return <line key={d} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={major ? 'tick major' : 'tick'} />; })}
      {SIDES.map(([label, d]) => { const p = at(d, R - 16); return <text key={label} x={p.x} y={p.y} textAnchor="middle" dominantBaseline="central">{label}</text>; })}
      <line x1={rim.x} y1={rim.y} x2={inner.x} y2={inner.y} className="arrow" />
      <polygon points={head.map(p => `${p.x},${p.y}`).join(' ')} className="arrow-head" />
      <circle cx={rim.x} cy={rim.y} r={6.5} className="handle" />
    </svg>
    <span className="wind-readout">Wind from {windLabel(shown)}</span>
  </div>;
}
