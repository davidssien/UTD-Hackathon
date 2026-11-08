import { useEffect, useState } from 'react';
import type { EgressDocument, PopulationBrushStroke } from '@egress/core';
import type { BuildingReach } from '@egress/sim';

/** Which exit each area walks to, computed off the render thread. Stale layouts are discarded. */
export function useExitReach(doc: EgressDocument | null, people: number, strokes: PopulationBrushStroke[]) {
  const [response, setResponse] = useState<{ doc: EgressDocument; people: number; strokes: PopulationBrushStroke[]; reach: BuildingReach } | null>(null);
  useEffect(() => {
    if (!doc) return;
    const worker = new Worker(new URL('./reach.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<BuildingReach>) => {
      setResponse({ doc, people, strokes, reach: event.data });
      worker.terminate();
    };
    worker.onerror = () => worker.terminate(); // no shading is better than a wrong one
    worker.postMessage({ doc, people, strokes });
    return () => worker.terminate();
  }, [doc, people, strokes]);
  return response && response.doc === doc && response.people === people && response.strokes === strokes ? response.reach : null;
}
