/**
 * `egress-fields-v1`: final heatmap aggregates stored in `sim_results.fields`.
 * gzip of a small JSON header followed by little-endian Float32 arrays.
 */
import { gunzipSync, gzipSync } from 'fflate';
import { DomainError } from '../errors.ts';
import { canonicalJson, utf8 } from '../canonical.ts';
import type { GridDefinition } from '../types.ts';

export const FIELDS_ENCODING = 'egress-fields-v1';

export interface FieldBundle {
  grid: GridDefinition;
  /** e.g. { 'people.congestion/timeAverage': Float32Array } — each width × height, row-major. */
  fields: Record<string, Float32Array>;
}

export function encodeFieldBundle(bundle: FieldBundle): Uint8Array {
  const names = Object.keys(bundle.fields).sort();
  const cells = bundle.grid.width * bundle.grid.height;
  for (const name of names) if (bundle.fields[name].length !== cells) throw new DomainError('INVALID_INPUT', `Field ${name} does not match the grid.`);
  const header = utf8(canonicalJson({ v: 1, grid: bundle.grid, names }));
  const pad = (4 - ((4 + header.length) % 4)) % 4;
  const bytes = new Uint8Array(4 + header.length + pad + names.length * cells * 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, header.length, true);
  bytes.set(header, 4);
  let offset = 4 + header.length + pad;
  for (const name of names) {
    const values = bundle.fields[name];
    for (let i = 0; i < cells; i++) view.setFloat32(offset + i * 4, values[i], true);
    offset += cells * 4;
  }
  return gzipSync(bytes, { level: 6 });
}

export function decodeFieldBundle(compressed: Uint8Array): FieldBundle {
  const bytes = gunzipSync(compressed);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLength))) as { v: number; grid: GridDefinition; names: string[] };
  if (header.v !== 1) throw new DomainError('INVALID_INPUT', `Unsupported field bundle version ${header.v}.`);
  const cells = header.grid.width * header.grid.height;
  const pad = (4 - ((4 + headerLength) % 4)) % 4;
  let offset = 4 + headerLength + pad;
  const fields: Record<string, Float32Array> = {};
  for (const name of header.names) {
    const values = new Float32Array(cells);
    for (let i = 0; i < cells; i++) values[i] = view.getFloat32(offset + i * 4, true);
    fields[name] = values;
    offset += cells * 4;
  }
  return { grid: header.grid, fields };
}
