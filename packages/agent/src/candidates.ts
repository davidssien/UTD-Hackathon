/**
 * Candidate design changes derived from measured hotspots. The agent never
 * invents geometry freehand: it picks from these validated suggestions (or
 * supplies commands that must pass applyEdit), and every candidate is then
 * measured with a real simulation.
 */
import {
  applyEdit, deriveLayout, distance, openingCenter, OPENING_END_CLEARANCE_M,
  type BottleneckMetric, type EditCommand, type EgressDocument, type Opening, type Vec2,
} from '@egress/core';

export interface Suggestion {
  suggestionId: string;
  title: string;
  /** One sentence the UI shows next to the ghost. */
  rationale: string;
  commands: EditCommand[];
  /** The opening or wall the change is anchored on. */
  targetId: string;
}

const NEAR_HOTSPOT_M = 3.5;

export function suggestionsFor(doc: EgressDocument, hotspots: BottleneckMetric[], limit = 4): Suggestion[] {
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const push = (s: Omit<Suggestion, 'suggestionId'>) => {
    const key = JSON.stringify(s.commands);
    if (seen.has(key) || out.length >= limit) return;
    const check = applyEdit(doc, { requestId: 'check', commands: s.commands });
    if (!check.ok) return;
    seen.add(key);
    out.push({ ...s, suggestionId: `s${out.length + 1}` });
  };

  for (const h of hotspots) {
    const near = nearestOpening(doc, h.floorId, h.regionCenter);
    if (!near || near.distance > NEAR_HOTSPOT_M) continue;
    const o = near.opening;
    const kind = o.openingKind === 'exit' ? 'exit' : 'door';
    for (const extra of [0.6, 0.3]) {
      const width = widestFit(doc, o, o.widthM + extra);
      if (width > o.widthM + 0.05) {
        push({
          title: `Widen the ${o.widthM.toFixed(1)} m ${kind} to ${width.toFixed(1)} m`,
          rationale: `People queue at this ${o.widthM.toFixed(1)} m ${kind}; a wider opening raises its flow capacity.`,
          commands: [{ kind: 'updateOpening', openingId: o.id, patch: { widthM: round(width) } }],
          targetId: o.id,
        });
        break;
      }
    }
    if (o.openingKind === 'exit') {
      const extraExit = secondExit(doc, h.floorId, h.regionCenter);
      if (extraExit) push(extraExit);
    }
  }
  return out;
}

function nearestOpening(doc: EgressDocument, floorId: string, p: Vec2): { opening: Opening; distance: number } | null {
  let best: { opening: Opening; distance: number } | null = null;
  for (const o of doc.openings) {
    if (o.floorId !== floorId || o.openingKind === 'window') continue;
    const c = openingCenter(doc, o);
    if (!c) continue;
    const d = distance(c, p);
    if (!best || d < best.distance) best = { opening: o, distance: d };
  }
  return best;
}

/** Widest width ≤ target that still fits the wall, keeping the opening centered where it is. */
function widestFit(doc: EgressDocument, o: Opening, target: number): number {
  const wall = doc.walls.find(w => w.id === o.wallId);
  const a = wall && doc.vertices.find(v => v.id === wall.startVertexId)?.position;
  const b = wall && doc.vertices.find(v => v.id === wall.endVertexId)?.position;
  if (!a || !b) return o.widthM;
  let lo = o.offsetM - OPENING_END_CLEARANCE_M, hi = distance(a, b) - o.offsetM - OPENING_END_CLEARANCE_M;
  for (const other of doc.openings) {
    if (other.wallId !== o.wallId || other.id === o.id) continue;
    if (other.offsetM < o.offsetM) lo = Math.min(lo, o.offsetM - (other.offsetM + other.widthM / 2) - 0.05);
    else hi = Math.min(hi, other.offsetM - other.widthM / 2 - o.offsetM - 0.05);
  }
  return Math.max(o.widthM, Math.min(target, 2 * Math.min(lo, hi)));
}

/** A 1.2 m exit in the middle of the longest outside wall far from the hotspot that has room for it. */
function secondExit(doc: EgressDocument, floorId: string, hotspot: Vec2): Omit<Suggestion, 'suggestionId'> | null {
  const { topology } = deriveLayout(doc);
  const isRoom = (faceId: string) => (topology.faceById.get(faceId)?.area ?? 0) > 1e-6;
  let best: { wallId: string; offset: number; score: number; mid: Vec2 } | null = null;
  for (const w of doc.walls) {
    if (w.floorId !== floorId) continue;
    const sides = topology.wallSides.get(w.id);
    if (!sides || isRoom(sides.left) === isRoom(sides.right)) continue; // must border the outside
    if (doc.openings.some(o => o.wallId === w.id)) continue;
    const a = doc.vertices.find(v => v.id === w.startVertexId)!.position, b = doc.vertices.find(v => v.id === w.endVertexId)!.position;
    const len = distance(a, b);
    if (len < 2.5) continue;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const score = Math.min(len, 8) + distance(mid, hotspot) * 0.5;
    if (!best || score > best.score) best = { wallId: w.id, offset: len / 2, score, mid };
  }
  if (!best) return null;
  return {
    title: 'Add a 1.2 m exit on an outside wall',
    rationale: `Everyone funnels to one exit; a second 1.2 m exit near (${best.mid.x.toFixed(0)}, ${best.mid.y.toFixed(0)}) splits the flow.`,
    commands: [{ kind: 'createOpening', wallId: best.wallId, openingKind: 'exit', offsetM: round(best.offset), widthM: 1.2 }],
    targetId: best.wallId,
  };
}

const round = (v: number) => Math.round(v * 100) / 100;
