/**
 * `egress-frames-v1`: binary replay chunk codec (docs/ARCHITECTURE.md §4).
 *
 * Layout before gzip (little-endian):
 *   0  u32 magic 'EGF1'      4  u16 version = 1   6  u16 reserved
 *   8  u32 actorCount       12  u32 firstTick    16  u16 frameCount  18 u16 reserved
 *   20 f32 originX          24  f32 originY      28  u32 reserved
 *   32 frame × frameCount:  u16 xCm[n] | u16 yCm[n] | u8 flags[n] | pad to 4 bytes
 *
 * Positions are centimeters relative to `origin` (the simulation grid origin),
 * so every coordinate must lie within [origin, origin + 655.35 m].
 * Multi-floor v2 uses the same header with version 2 and absolute signed centimetres:
 * i32 x[n] | i32 y[n] | i32 elevation[n] | u16 floor[n] | u8 flags[n] | pad.
 * Ticks inside a chunk are consecutive: frame i has tick `firstTick + i`.
 */
import { gunzipSync, gzipSync } from 'fflate';
import { DomainError } from '../errors.ts';
import type { ActorFrame, ReplayChunk, Vec2 } from '../types.ts';

export const FRAME_ENCODING = 'egress-frames-v1';
export const MULTIFLOOR_FRAME_ENCODING = 'egress-frames-v2';
export const frameEncoding = (frame: ActorFrame) => frame.actorFloor ? MULTIFLOOR_FRAME_ENCODING : FRAME_ENCODING;
const MAGIC = 0x31464745; // 'EGF1' read as little-endian u32
const HEADER_BYTES = 32;
const MAX_CM = 0xffff;

const frameBytes = (actorCount: number, multi: boolean) => {
  const raw = actorCount * (multi ? 15 : 5);
  return raw + ((4 - (raw % 4)) % 4);
};

export function encodeChunk(chunk: ReplayChunk, origin: Vec2): Uint8Array {
  const { actorCount, frames } = chunk;
  if (frames.length === 0 || frames.length > 0xffff) throw new DomainError('INVALID_INPUT', 'A chunk needs 1–65535 frames.');
  const multi = !!frames[0].actorFloor;
  const bytes = new Uint8Array(HEADER_BYTES + frames.length * frameBytes(actorCount, multi));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint16(4, multi ? 2 : 1, true);
  view.setUint32(8, actorCount, true);
  view.setUint32(12, chunk.firstTick, true);
  view.setUint16(16, frames.length, true);
  view.setFloat32(20, origin.x, true);
  view.setFloat32(24, origin.y, true);

  let offset = HEADER_BYTES;
  frames.forEach((frame, i) => {
    if (frame.tick !== chunk.firstTick + i) throw new DomainError('INVALID_INPUT', `Frame ${i} has tick ${frame.tick}; expected ${chunk.firstTick + i}.`);
    if (frame.actorXY.length !== actorCount * 2 || frame.actorFlags.length !== actorCount) throw new DomainError('INVALID_INPUT', 'Frame arrays do not match actorCount.');
    if (multi) {
      if (frame.actorFloor?.length !== actorCount || frame.actorElevation?.length !== actorCount) throw new DomainError('INVALID_INPUT', 'Multi-floor frames require floor and height for every person.');
      for (let a = 0; a < actorCount; a++) {
        view.setInt32(offset + a * 4, Math.round(frame.actorXY[a * 2] * 100), true);
        view.setInt32(offset + (actorCount + a) * 4, Math.round(frame.actorXY[a * 2 + 1] * 100), true);
        view.setInt32(offset + (2 * actorCount + a) * 4, Math.round(frame.actorElevation[a] * 100), true);
        view.setUint16(offset + actorCount * 12 + a * 2, frame.actorFloor[a], true);
      }
    } else {
      if (frame.actorFloor || frame.actorElevation) throw new DomainError('INVALID_INPUT', 'Mixed replay frame versions.');
      for (let a = 0; a < actorCount; a++) {
        view.setUint16(offset + a * 2, quantize(frame.actorXY[a * 2] - origin.x), true);
        view.setUint16(offset + actorCount * 2 + a * 2, quantize(frame.actorXY[a * 2 + 1] - origin.y), true);
      }
    }
    bytes.set(frame.actorFlags, offset + actorCount * (multi ? 14 : 4));
    offset += frameBytes(actorCount, multi);
  });
  return gzipSync(bytes, { level: 6 });
}

export function decodeChunk(compressed: Uint8Array): ReplayChunk & { origin: Vec2 } {
  const bytes = gunzipSync(compressed);
  if (bytes.length < HEADER_BYTES) throw new DomainError('INVALID_INPUT', 'Replay chunk is truncated.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new DomainError('INVALID_INPUT', 'Not an egress-frames chunk.');
  const version = view.getUint16(4, true);
  const multi = version === 2;
  if (version !== 1 && !multi) throw new DomainError('INVALID_INPUT', `Unsupported frame codec version ${version}.`);
  const actorCount = view.getUint32(8, true);
  const firstTick = view.getUint32(12, true);
  const frameCount = view.getUint16(16, true);
  const origin = { x: view.getFloat32(20, true), y: view.getFloat32(24, true) };
  if (bytes.length !== HEADER_BYTES + frameCount * frameBytes(actorCount, multi)) throw new DomainError('INVALID_INPUT', 'Replay chunk length does not match its header.');

  const frames: ActorFrame[] = [];
  let offset = HEADER_BYTES;
  for (let f = 0; f < frameCount; f++) {
    const actorXY = new Float32Array(actorCount * 2);
    const flagOffset = offset + actorCount * (multi ? 14 : 4);
    const frame: ActorFrame = { tick: firstTick + f, actorXY, actorFlags: bytes.slice(flagOffset, flagOffset + actorCount) };
    if (multi) {
      frame.actorFloor = new Uint16Array(actorCount);
      frame.actorElevation = new Float32Array(actorCount);
      for (let a = 0; a < actorCount; a++) {
        actorXY[a * 2] = view.getInt32(offset + a * 4, true) / 100;
        actorXY[a * 2 + 1] = view.getInt32(offset + (actorCount + a) * 4, true) / 100;
        frame.actorElevation[a] = view.getInt32(offset + (2 * actorCount + a) * 4, true) / 100;
        frame.actorFloor[a] = view.getUint16(offset + actorCount * 12 + a * 2, true);
      }
    } else {
      for (let a = 0; a < actorCount; a++) {
        actorXY[a * 2] = origin.x + view.getUint16(offset + a * 2, true) / 100;
        actorXY[a * 2 + 1] = origin.y + view.getUint16(offset + actorCount * 2 + a * 2, true) / 100;
      }
    }
    frames.push(frame);
    offset += frameBytes(actorCount, multi);
  }
  return { actorCount, firstTick, frames, origin };
}

function quantize(meters: number): number {
  const cm = Math.round(meters * 100);
  return cm < 0 ? 0 : cm > MAX_CM ? MAX_CM : cm;
}
