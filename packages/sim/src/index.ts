/**
 * @egress/sim — pedestrian simulation (Plan.md §6). Pure TS; depends only on
 * @egress/core. Implemented in Pass 2; this is the model-agnostic lifecycle
 * every model (pedestrian now, airflow/smoke later) implements.
 */
import type { ActorFrame, EgressDocument, GridDefinition, SimulationMetrics, SimulationScenario } from '@egress/core';

export interface FrozenSimulationInput {
  runId: string;
  document: EgressDocument;
  layoutHash: string;
  scenario: SimulationScenario;
}

export interface SimulationModel<State> {
  readonly modelId: string;
  readonly modelVersion: string;
  initialize(input: FrozenSimulationInput): State;
  /** Advances exactly one fixed 0.1 s tick. */
  step(state: State): void;
  frame(state: State): ActorFrame;
  metrics(state: State): SimulationMetrics;
  isComplete(state: State): boolean;
  grid(state: State): GridDefinition;
}
