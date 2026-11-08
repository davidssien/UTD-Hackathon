import { useEffect, useState } from 'react';
import type { PlaybackController, RunSummary } from '@egress/client';
import type { ScalarField } from '@egress/core';
import { advanceHazard, createHazard, fireRadius, smokeField, type Hazard } from '@egress/sim';

export interface HazardView { floorId: string; fireRadiusM: number; smoke: ScalarField }

/**
 * Fire and smoke at the playhead of a hazard run. The model is independent of the crowd, so
 * every viewer recomputes the same state from the run's frozen layout and scenario elements.
 * It steps forward with the playhead twice a second and restarts when scrubbed backwards.
 */
export function useHazardPlayback(playback: PlaybackController | null, run: RunSummary | undefined): HazardView | null {
  const [view, setView] = useState<HazardView | null>(null);
  const hasFire = !!run?.elements?.some(e => e.kind === 'fire');
  useEffect(() => {
    if (!playback || !run || !hasFire) { queueMicrotask(() => setView(null)); return; }
    let hazard: Hazard | null = null, layout: unknown = null;
    const update = () => {
      const doc = playback.runLayout();
      if (!doc) return;
      const tick = Math.max(0, Math.floor(playback.state.get().tick));
      if (!hazard || layout !== doc || tick < hazard.tick) { hazard = createHazard(doc, run); layout = doc; }
      if (!hazard) return;
      advanceHazard(hazard, tick);
      setView({ floorId: hazard.floorId, fireRadiusM: Math.max(0, fireRadius(hazard, tick)), smoke: smokeField(hazard) });
    };
    update();
    const timer = setInterval(update, 500);
    return () => clearInterval(timer);
  }, [playback, run?.id, hasFire]); // eslint-disable-line react-hooks/exhaustive-deps
  return view;
}
