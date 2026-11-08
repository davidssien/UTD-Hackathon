/**
 * @egress/sim — pedestrian simulation (docs/ARCHITECTURE.md §6). Pure TS; depends only on
 * @egress/core, so it runs in the runner, the browser (mock client, live
 * heatmaps) and tests alike.
 *
 *   const state = initialize({ runId, document, scenario });
 *   while (!isComplete(state)) step(state);       // fixed 0.1 s ticks
 *   metrics(state); state.fields.field('people.congestion', 'timeAverage');
 */
export { compileFloor, FLOW_PER_METER, forEachCellInGap, blockingDiagnostics, type CompiledFloor, type Portal } from './compile.ts';
export { buildNavigation, type Navigation } from './nav.ts';
export { downsampleField, FieldAccumulator, FREE_WALK_SPEED } from './fields.ts';
export {
  endReason, frame, initialize, isComplete, metrics, MODEL_ID, MODEL_VERSION, PARAMS, populationCapacity, step, type FrozenSimulationInput, type InitialActors, type SimState,
} from './model.ts';
export { runSimulation, simulateChunks, type RunChunk, type RunResult } from './run.ts';
export { structuralField, type StructuralFieldId } from './structural.ts';
export { escapeRoutes, type EscapeRoute } from './routes.ts';
export { isSpawnable, MAX_PAINT_WEIGHT, paintWeights } from './paint.ts';
export { floorAirflow, WIND_FROM, type FloorAirflow, type WindFrom } from './airflow.ts';
