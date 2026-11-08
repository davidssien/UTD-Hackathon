import { floorAirflow, type WindFrom } from '@egress/sim';
import type { EgressDocument } from '@egress/core';

self.onmessage = ({ data }: MessageEvent<{ doc: EgressDocument; floorId: string; wind: WindFrom }>) => {
  const flow = floorAirflow(data.doc, data.floorId, data.wind);
  self.postMessage(flow, { transfer: [flow.magnitude.values.buffer, flow.x.buffer, flow.y.buffer] });
};
