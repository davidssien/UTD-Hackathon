/**
 * Drivers around the model lifecycle: iterate a run as replay chunks (runner,
 * mock client) or run it straight to completion (tests, agent tool calls).
 */
import { FRAMES_PER_CHUNK, type ActorFrame, type ReplayChunk, type SimulationMetrics } from '@egress/core';
import { frame, initialize, isComplete, metrics, step, type FrozenSimulationInput, type SimState } from './model.ts';

export interface RunChunk extends ReplayChunk {
  /** Simulation metrics as of the last frame in this chunk. */
  metrics: SimulationMetrics;
  /** True for the final chunk of the run. */
  last: boolean;
}

/** Yields 2-second chunks (20 frames) until the run completes. Frame 0 is the initial state. */
export function* simulateChunks(state: SimState, framesPerChunk = FRAMES_PER_CHUNK): Generator<RunChunk> {
  let frames: ActorFrame[] = [frame(state)];
  for (;;) {
    const done = isComplete(state);
    if (frames.length >= framesPerChunk || done) {
      yield { actorCount: state.n, firstTick: frames[0].tick, frames, metrics: metrics(state), last: done };
      frames = [];
      if (done) return;
    }
    step(state);
    frames.push(frame(state));
  }
}

export interface RunResult {
  state: SimState;
  metrics: SimulationMetrics;
  chunks: RunChunk[];
  computeMs: number;
}

/** Run to completion, keeping every chunk. */
export function runSimulation(input: FrozenSimulationInput, options: { keepChunks?: boolean } = {}): RunResult {
  const started = Date.now();
  const state = initialize(input);
  const chunks: RunChunk[] = [];
  for (const chunk of simulateChunks(state)) if (options.keepChunks !== false) chunks.push(chunk);
  return { state, metrics: metrics(state), chunks, computeMs: Date.now() - started };
}
