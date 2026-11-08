/**
 * Client-side playback of a run (docs/ARCHITECTURE.md §8, D14). Shared by the mock and the
 * SpacetimeDB client: they feed decoded frames in with `pushFrames`, and the UI
 * drives play / pause / seek / ±10 s / go-live. Pausing or scrubbing never
 * touches the server; the runner keeps simulating to completion.
 */
import {
  ACTOR_EXITED, floorsByLevel, TICK_RATE_HZ, type ActorFrame, type Aggregation, type FieldId, type ID, type RunStatus, type ScalarField,
  type EgressDocument, type SimulationMetrics,
} from '@egress/core';
import { compileFloor, FieldAccumulator, PARAMS } from '@egress/sim';
import { writable, type WritableStore } from './store.ts';
import type { PlaybackController, PlaybackState } from './types.ts';

export interface PlaybackClock {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const systemClock: PlaybackClock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * LIVE badge debounce (PLAN.md D82): following live trails the newest frame by about one 2 s
 * chunk so playback never stalls between chunks. The badge turns on within 1 s of the
 * edge and only turns off once the playhead is more than 4 s behind, or the user scrubs back.
 */
export const LIVE_FOLLOW_BUFFER_TICKS = 2 * TICK_RATE_HZ;
const LIVE_ON_TICKS = 1 * TICK_RATE_HZ;
const LIVE_OFF_TICKS = 4 * TICK_RATE_HZ;

export class Playback implements PlaybackController {
  readonly state: WritableStore<PlaybackState>;
  readonly metrics = writable<SimulationMetrics | null>(null);
  private readonly frames: (ActorFrame | undefined)[] = [];
  private readonly clock: PlaybackClock;
  private timer: unknown = null;
  private lastWall = 0;
  private finished = false;
  private layout: EgressDocument | null = null;
  private accumulator: FieldAccumulator | null = null;
  private accumulatedTo = -1;
  private live = true;

  constructor(runId: ID, clock: PlaybackClock = systemClock) {
    this.clock = clock;
    this.state = writable<PlaybackState>({
      runId, status: 'queued', tick: 0, liveTick: 0, atLiveEdge: true, playing: false, complete: false, speed: 1, actorCount: 0,
    });
  }

  // ── Feeding (called by client implementations) ──

  pushFrames(frames: ActorFrame[]): void {
    if (!frames.length) return;
    let live = this.state.get().liveTick;
    for (const f of frames) {
      this.frames[f.tick] = f;
      if (f.tick > live) live = f.tick;
    }
    const actorCount = frames[0].actorFlags.length;
    this.patch({ liveTick: live, actorCount, complete: this.finished && this.isContiguous(live) });
  }

  setStatus(status: RunStatus): void {
    this.finished = status === 'complete' || status === 'failed' || status === 'cancelled';
    const s = this.state.get();
    this.patch({ status, complete: this.finished && this.isContiguous(s.liveTick) });
  }

  setMetrics(metrics: SimulationMetrics | null): void {
    this.metrics.set(metrics);
  }

  /** Advance the playhead by wall-clock time. Called by the internal timer; exposed for tests. */
  tickClock(): void {
    const s = this.state.get();
    const now = this.clock.now();
    const elapsed = (now - this.lastWall) / 1000;
    this.lastWall = now;
    if (!s.playing) return;
    let tick = s.tick + elapsed * TICK_RATE_HZ * s.speed;
    let playing: boolean = true;
    if (tick >= s.liveTick) {
      tick = s.liveTick;
      if (s.complete) playing = false; // reached END
    }
    this.patch({ tick, playing });
  }

  // ── PlaybackController ──

  play(): void {
    const s = this.state.get();
    if (s.complete && s.tick >= s.liveTick) this.patch({ tick: 0 });
    this.lastWall = this.clock.now();
    this.patch({ playing: true });
    this.ensureTimer();
  }

  pause(): void {
    this.patch({ playing: false });
  }

  toggle(): void {
    if (this.state.get().playing) this.pause();
    else this.play();
  }

  seek(tick: number): void {
    const s = this.state.get();
    const next = Math.max(0, Math.min(s.liveTick, tick));
    if (next < s.tick && s.liveTick - next > LIVE_ON_TICKS) this.live = false; // scrubbing back leaves LIVE at once
    this.patch({ tick: next });
  }

  skip(seconds: number): void {
    this.seek(this.state.get().tick + seconds * TICK_RATE_HZ);
  }

  /** Jump to the LIVE edge and follow it; on a finished run, jump to END and stop there. */
  goLive(): void {
    const s = this.state.get();
    if (s.complete) { this.seek(s.liveTick); this.pause(); return; }
    this.live = true;
    this.patch({ tick: Math.max(s.tick, s.liveTick - LIVE_FOLLOW_BUFFER_TICKS, 0) });
    this.play();
  }

  setSpeed(speed: number): void {
    this.patch({ speed: Math.max(0.25, Math.min(8, speed)) });
  }

  actorsNow(): ActorFrame | null {
    const t = this.state.get().tick;
    const i0 = Math.floor(t);
    const a = this.frameAtOrBefore(i0);
    if (!a) return null;
    const b = this.frames[i0 + 1];
    const alpha = t - i0;
    if (!b || alpha <= 0 || a.tick !== i0) return a;
    const xy = new Float32Array(a.actorXY.length);
    const elevation = a.actorElevation?.slice();
    for (let i = 0; i < a.actorFlags.length; i++) {
      // Exited actors stay where they left; do not slide them toward a stale position.
      const k = a.actorFlags[i] === ACTOR_EXITED ? 0 : alpha;
      if (elevation && b.actorElevation) elevation[i] += (b.actorElevation[i] - elevation[i]) * k;
      xy[i * 2] = a.actorXY[i * 2] + (b.actorXY[i * 2] - a.actorXY[i * 2]) * k;
      xy[i * 2 + 1] = a.actorXY[i * 2 + 1] + (b.actorXY[i * 2 + 1] - a.actorXY[i * 2 + 1]) * k;
    }
    return { ...a, tick: t, actorXY: xy, actorElevation: elevation };
  }

  runLayout(): EgressDocument | null {
    return this.layout;
  }

  /** The run's frozen layout; enables heatmaps computed from frames (D15). */
  setLayout(doc: EgressDocument): void {
    if (this.layout === doc) return;
    this.layout = doc;
    this.accumulator = null;
    this.accumulatedTo = -1;
  }

  /**
   * Heatmap at the playhead: 'instant' is the latest 2 Hz sample at or before it;
   * 'timeAverage' and 'perCellPeak' accumulate from the start of the run up to it.
   * Scrubbing backwards recomputes from tick 0 (cheap: ~25 cell updates per person per sample).
   */
  field(id: FieldId, aggregation: Aggregation, floorId?: string): ScalarField | null {
    if (!this.layout) return null;
    const every = PARAMS.fieldEvery;
    const target = Math.floor(this.state.get().tick / every) * every;
    const floors = floorsByLevel(this.layout);
    const floor = floorId ? floors.findIndex(f => f.id === floorId) : 0;
    if (floor < 0) return null;
    if (!this.accumulator || target < this.accumulatedTo || this.accumulator.compiled.floorId !== floors[floor].id) {
      this.accumulator = new FieldAccumulator(compileFloor(this.layout, floors[floor].id));
      this.accumulatedTo = -every;
    }
    for (let t = this.accumulatedTo + every; t <= target; t += every) {
      const f = this.frames[t];
      if (!f) break;
      this.accumulator.addFrame(f, this.frames[t - 1] ?? null, floor);
      this.accumulatedTo = t;
    }
    return this.accumulator.field(id, aggregation);
  }

  /** All frames received so far, in tick order (gaps skipped). */
  loadedFrames(): ActorFrame[] {
    return this.frames.filter((f): f is ActorFrame => !!f);
  }

  dispose(): void {
    if (this.timer !== null) this.clock.clearInterval(this.timer);
    this.timer = null;
  }

  // ── internals ──

  private ensureTimer() {
    if (this.timer === null) this.timer = this.clock.setInterval(() => this.tickClock(), 33);
  }

  private frameAtOrBefore(tick: number): ActorFrame | undefined {
    for (let i = Math.min(tick, this.frames.length - 1); i >= 0; i--) if (this.frames[i]) return this.frames[i];
    return undefined;
  }

  private isContiguous(upTo: number): boolean {
    for (let i = 0; i <= upTo; i++) if (!this.frames[i]) return false;
    return true;
  }

  private patch(p: Partial<PlaybackState>) {
    const s = { ...this.state.get(), ...p };
    const behind = s.liveTick - s.tick;
    if (behind <= LIVE_ON_TICKS) this.live = true;
    else if (behind > LIVE_OFF_TICKS) this.live = false;
    s.atLiveEdge = this.live;
    this.state.set(s);
  }
}
