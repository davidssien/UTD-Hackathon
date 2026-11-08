/**
 * Derived layout: everything computed from an EgressDocument and never stored.
 * Cached per document object, so UI code can call `deriveLayout(doc)` on every
 * render for free.
 */
import type { EgressDocument } from '../types.ts';
import { diagnostics, type GeometryDiagnostic } from './diagnostics.ts';
import { topology, type Topology } from './topology.ts';
import { wallGeometry, type WallGeometry } from './walls.ts';

export * from './walls.ts';
export * from './topology.ts';
export * from './diagnostics.ts';
export * from './rooms.ts';

export interface DerivedLayout {
  /** Every opening cut out — for rendering. */
  walls: WallGeometry;
  topology: Topology;
  diagnostics: GeometryDiagnostic[];
}

const cache = new WeakMap<EgressDocument, DerivedLayout>();

export function deriveLayout(doc: EgressDocument): DerivedLayout {
  let derived = cache.get(doc);
  if (!derived) {
    const topo = topology(doc);
    derived = { walls: wallGeometry(doc), topology: topo, diagnostics: diagnostics(doc, topo) };
    cache.set(doc, derived);
  }
  return derived;
}
