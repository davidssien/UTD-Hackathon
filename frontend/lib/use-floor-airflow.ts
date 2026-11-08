import { useEffect, useState } from 'react';
import type { EgressDocument } from '@egress/core';
import type { FloorAirflow, WindFrom } from '@egress/sim';

/** Compute a selected layer off the render thread. Discard stale geometry and wind responses. */
export function useFloorAirflow(doc: EgressDocument | null, floorId: string | undefined, wind: WindFrom) {
  const [response, setResponse] = useState<{
    doc: EgressDocument; floorId: string; wind: WindFrom; flow?: FloorAirflow; error?: string;
  } | null>(null);
  useEffect(() => {
    if (!doc || !floorId) return;
    const worker = new Worker(new URL('./airflow.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<FloorAirflow>) => {
      setResponse({ doc, floorId, wind, flow: event.data });
      worker.terminate();
    };
    worker.onerror = () => {
      setResponse({ doc, floorId, wind, error: 'Airflow could not be calculated for this floor.' });
      worker.terminate();
    };
    worker.postMessage({ doc, floorId, wind });
    return () => worker.terminate();
  }, [doc, floorId, wind]);
  return response && response.doc === doc && response.floorId === floorId && response.wind === wind ? response : null;
}
