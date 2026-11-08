/**
 * Crowd fields (docs/ARCHITECTURE.md §6 "Fields", D15). The same accumulator runs inside
 * the simulation (authoritative final aggregates) and in the browser over
 * decoded frames (live Current / Average / Peak overlays).
 *
 * Density uses a 5×5-cell (1.25 m) box kernel restricted to the actor's own
 * room, normalised by how many same-room cells the kernel covers, so density
 * never bleeds through walls and is not diluted next to them.
 */
import type { ActorFrame, Aggregation, FieldId, ScalarField } from '@egress/core';
import { ACTOR_EXITED, ACTOR_TRANSITIONING, TICK_RATE_HZ } from '@egress/core';
import type { CompiledFloor } from './compile.ts';

export const FREE_WALK_SPEED = 1.34;
const KERNEL = 2; // cells each side → 5×5

export class FieldAccumulator {
  readonly compiled: CompiledFloor;
  private readonly n: number;
  private readonly kernelCells: Float32Array;
  readonly density: Float32Array;
  readonly speed: Float32Array;
  readonly congestion: Float32Array;
  private readonly speedWeight: Float32Array;
  readonly densitySum: Float32Array;
  readonly congestionSum: Float32Array;
  readonly densityPeak: Float32Array;
  readonly congestionPeak: Float32Array;
  readonly congestionPeakTick: Int32Array;
  private readonly everOccupied: Uint8Array;
  private touched: number[] = [];
  samples = 0;
  lastTick = 0;

  constructor(compiled: CompiledFloor) {
    this.compiled = compiled;
    const { width, height } = compiled.grid;
    this.n = width * height;
    this.kernelCells = new Float32Array(this.n);
    for (let cy = 0; cy < height; cy++) for (let cx = 0; cx < width; cx++) {
      const i = cy * width + cx;
      if (compiled.room[i] < 0) continue;
      let count = 0;
      this.forKernel(cx, cy, compiled.room[i], () => { count++; });
      this.kernelCells[i] = count;
    }
    this.density = new Float32Array(this.n);
    this.speed = new Float32Array(this.n);
    this.congestion = new Float32Array(this.n);
    this.speedWeight = new Float32Array(this.n);
    this.densitySum = new Float32Array(this.n);
    this.congestionSum = new Float32Array(this.n);
    this.densityPeak = new Float32Array(this.n);
    this.congestionPeak = new Float32Array(this.n);
    this.congestionPeakTick = new Int32Array(this.n).fill(-1);
    this.everOccupied = new Uint8Array(this.n);
  }

  private forKernel(cx: number, cy: number, room: number, fn: (i: number) => void) {
    const { width, height } = this.compiled.grid;
    for (let y = Math.max(0, cy - KERNEL); y <= Math.min(height - 1, cy + KERNEL); y++) {
      for (let x = Math.max(0, cx - KERNEL); x <= Math.min(width - 1, cx + KERNEL); x++) {
        const j = y * width + x;
        if (this.compiled.room[j] === room && this.compiled.walkable[j] > 0) fn(j);
      }
    }
  }

  /** Add one sample: positions, speeds (m/s) and which actors are still inside. */
  addSample(tick: number, count: number, x: ArrayLike<number>, y: ArrayLike<number>, speed: ArrayLike<number>, active: (i: number) => boolean): void {
    const { origin, cellSizeM: cell, width, height } = this.compiled.grid;
    const area = cell * cell;
    for (const i of this.touched) { this.density[i] = 0; this.speed[i] = 0; this.speedWeight[i] = 0; this.congestion[i] = 0; }
    const touched: number[] = [];
    for (let a = 0; a < count; a++) {
      if (!active(a)) continue;
      const cx = Math.floor((x[a] - origin.x) / cell), cy = Math.floor((y[a] - origin.y) / cell);
      if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue;
      const room = this.compiled.room[cy * width + cx];
      if (room < 0) continue;
      this.forKernel(cx, cy, room, j => {
        if (this.speedWeight[j] === 0) touched.push(j);
        this.density[j] += 1 / (this.kernelCells[j] * area);
        this.speed[j] += speed[a];
        this.speedWeight[j] += 1;
      });
    }
    for (const j of touched) {
      this.speed[j] /= this.speedWeight[j];
      this.congestion[j] = this.density[j] * Math.max(0, 1 - this.speed[j] / FREE_WALK_SPEED);
      this.densitySum[j] += this.density[j];
      this.congestionSum[j] += this.congestion[j];
      if (this.density[j] > this.densityPeak[j]) this.densityPeak[j] = this.density[j];
      if (this.congestion[j] > this.congestionPeak[j]) { this.congestionPeak[j] = this.congestion[j]; this.congestionPeakTick[j] = tick; }
      this.everOccupied[j] = 1;
    }
    this.touched = touched;
    this.samples++;
    this.lastTick = tick;
  }

  /** Browser path: derive speeds from the previous frame and add a sample. */
  addFrame(frame: ActorFrame, previous: ActorFrame | null, floor = 0, only?: Uint8Array): void {
    const count = frame.actorFlags.length;
    const xs = new Float64Array(count), ys = new Float64Array(count), speeds = new Float64Array(count);
    const dt = previous ? Math.max(1e-6, (frame.tick - previous.tick) / TICK_RATE_HZ) : 1;
    for (let i = 0; i < count; i++) {
      xs[i] = frame.actorXY[i * 2];
      ys[i] = frame.actorXY[i * 2 + 1];
      speeds[i] = previous ? Math.hypot(xs[i] - previous.actorXY[i * 2], ys[i] - previous.actorXY[i * 2 + 1]) / dt : FREE_WALK_SPEED;
    }
    this.addSample(frame.tick, count, xs, ys, speeds, i => (!only || only[i] === 1) && (frame.actorFloor?.[i] ?? 0) === floor && frame.actorFlags[i] !== ACTOR_EXITED && frame.actorFlags[i] !== ACTOR_TRANSITIONING);
  }

  field(fieldId: FieldId, aggregation: Aggregation): ScalarField | null {
    const grid = this.compiled.grid;
    const values = new Float32Array(this.n);
    const pick = (): Float32Array | null => {
      if (fieldId === 'people.density') return aggregation === 'instant' ? this.density : aggregation === 'perCellPeak' ? this.densityPeak : this.average(this.densitySum);
      if (fieldId === 'people.congestion') return aggregation === 'instant' ? this.congestion : aggregation === 'perCellPeak' ? this.congestionPeak : this.average(this.congestionSum);
      if (fieldId === 'people.speed') return this.speed;
      if (fieldId === 'people.exitDistance') return this.exitDistance();
      return null;
    };
    const source = pick();
    if (!source) return null;
    for (let i = 0; i < this.n; i++) values[i] = this.compiled.navigable[i] ? source[i] : NaN;
    const units = fieldId === 'people.density' ? 'people/m²' : fieldId === 'people.speed' ? 'm/s' : fieldId === 'people.exitDistance' ? 'm' : 'congestion index';
    return { fieldId, aggregation, grid, units, values };
  }

  private average(sum: Float32Array): Float32Array {
    const out = new Float32Array(this.n);
    if (this.samples === 0) return out;
    for (let i = 0; i < this.n; i++) out[i] = sum[i] / this.samples;
    return out;
  }

  private exitDistance(): Float32Array {
    const out = new Float32Array(this.n).fill(Infinity);
    for (const f of this.compiled.nav.fields) for (let i = 0; i < this.n; i++) if (f[i] < out[i]) out[i] = f[i];
    return out;
  }

  /** Mean of time-averaged congestion over cells anyone ever stood in, and the overall peak. */
  congestionSummary(): { mean: number; peak: number; cells: number } {
    let sum = 0, cells = 0, peak = 0;
    for (let i = 0; i < this.n; i++) {
      if (!this.everOccupied[i]) continue;
      cells++;
      sum += this.samples ? this.congestionSum[i] / this.samples : 0;
      if (this.congestionPeak[i] > peak) peak = this.congestionPeak[i];
    }
    return { mean: cells ? sum / cells : 0, peak, cells };
  }

  /** Top-k local maxima of time-averaged congestion, at least `separationM` apart. */
  hotspots(k = 5, separationM = 1.5): { x: number; y: number; score: number; peakTick: number }[] {
    const { width, height, origin, cellSizeM: cell } = this.compiled.grid;
    if (!this.samples) return [];
    const avg = this.average(this.congestionSum);
    const candidates: { i: number; v: number }[] = [];
    for (let cy = 0; cy < height; cy++) for (let cx = 0; cx < width; cx++) {
      const i = cy * width + cx;
      const v = avg[i];
      if (v <= 0.02) continue;
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, y = cy + dy;
        if ((dx || dy) && x >= 0 && y >= 0 && x < width && y < height && avg[y * width + x] > v) { isMax = false; break; }
      }
      if (isMax) candidates.push({ i, v });
    }
    candidates.sort((a, b) => b.v - a.v || a.i - b.i);
    const picked: { x: number; y: number; score: number; peakTick: number }[] = [];
    for (const c of candidates) {
      const cx = c.i % width, cy = (c.i - cx) / width;
      const p = { x: origin.x + (cx + 0.5) * cell, y: origin.y + (cy + 0.5) * cell };
      if (picked.some(q => Math.hypot(q.x - p.x, q.y - p.y) < separationM)) continue;
      picked.push({ ...p, score: c.v, peakTick: this.congestionPeakTick[c.i] });
      if (picked.length >= k) break;
    }
    return picked;
  }
}

/**
 * Coarser view of a field for the heatmap "granularity" option: averages
 * factor×factor blocks of finite cells (NaN cells are ignored; all-NaN blocks stay NaN).
 */
export function downsampleField(field: ScalarField, factor: number): ScalarField {
  const f = Math.max(1, Math.floor(factor));
  if (f === 1) return field;
  const { width, height, cellSizeM } = field.grid;
  const w = Math.ceil(width / f), h = Math.ceil(height / f);
  const values = new Float32Array(w * h);
  for (let by = 0; by < h; by++) {
    for (let bx = 0; bx < w; bx++) {
      let sum = 0, count = 0;
      for (let y = by * f; y < Math.min(height, by * f + f); y++) {
        for (let x = bx * f; x < Math.min(width, bx * f + f); x++) {
          const v = field.values[y * width + x];
          if (Number.isFinite(v)) { sum += v; count++; }
        }
      }
      values[by * w + bx] = count ? sum / count : NaN;
    }
  }
  return { ...field, grid: { ...field.grid, cellSizeM: cellSizeM * f, width: w, height: h }, values };
}
