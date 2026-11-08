import { exitReach } from '@egress/sim';
import type { EgressDocument, PopulationBrushStroke } from '@egress/core';

self.onmessage = ({ data }: MessageEvent<{ doc: EgressDocument; people: number; strokes: PopulationBrushStroke[] }>) => {
  const reach = exitReach(data.doc, data.people, data.strokes);
  self.postMessage(reach, { transfer: Object.values(reach.floors).map(f => f.cells.buffer as ArrayBuffer) });
};
