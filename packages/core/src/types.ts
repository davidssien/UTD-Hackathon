/**
 * Domain types. JSON shapes are inferred from `schemas.ts`; runtime-only shapes
 * (typed arrays, derived geometry) are declared here. See docs/ARCHITECTURE.md §4.
 */
import type { z } from 'zod';
import type * as S from './schemas.ts';

export type ID = string;
export type Vec2 = z.infer<typeof S.Vec2Schema>;
export type WallMaterial = z.infer<typeof S.WallMaterialSchema>;
export type OpeningKind = z.infer<typeof S.OpeningKindSchema>;
export type OpeningState = z.infer<typeof S.OpeningStateSchema>;
export type Role = z.infer<typeof S.RoleSchema>;

export type Floor = z.infer<typeof S.FloorSchema>;
export type Vertex = z.infer<typeof S.VertexSchema>;
export type Wall = z.infer<typeof S.WallSchema>;
export type Opening = z.infer<typeof S.OpeningSchema>;
export type Slab = z.infer<typeof S.SlabSchema>;
export type SlabMaterial = z.infer<typeof S.SlabMaterialSchema>;
export type Stair = z.infer<typeof S.StairSchema>;
export type Placeable = z.infer<typeof S.PlaceableSchema>;
export type PlaceableItem = z.infer<typeof S.PlaceableItemSchema>;
export type Entity = z.infer<typeof S.EntitySchema>;
export type EntityKind = Entity['kind'];
export type EgressDocument = z.infer<typeof S.EgressDocumentSchema>;

export type EditCommand = z.infer<typeof S.EditCommandSchema>;
export type EditCommandKind = EditCommand['kind'];
export type EditRequest = z.infer<typeof S.EditRequestSchema>;

export type PopulationBrushStroke = z.infer<typeof S.PopulationBrushStrokeSchema>;
export type ScenarioGoal = z.infer<typeof S.ScenarioGoalSchema>;
export type SimulationScenario = z.infer<typeof S.SimulationScenarioSchema>;

export type Pace = z.infer<typeof S.PaceSchema>;
export type RunStatus = z.infer<typeof S.RunStatusSchema>;
export type FieldId = z.infer<typeof S.FieldIdSchema>;
export type Aggregation = z.infer<typeof S.AggregationSchema>;
export type GridDefinition = z.infer<typeof S.GridDefinitionSchema>;
export type BottleneckMetric = z.infer<typeof S.BottleneckMetricSchema>;
export type SimulationMetrics = z.infer<typeof S.SimulationMetricsSchema>;

export type AgentStepKind = z.infer<typeof S.AgentStepKindSchema>;
export type ProposalStatus = z.infer<typeof S.ProposalStatusSchema>;
export type AgentContext = z.infer<typeof S.AgentContextSchema>;
export type ProposalNotes = z.infer<typeof S.ProposalNotesSchema>;

// ── Runtime-only shapes ─────────────────────────────────────────────────────

/** 0 moving · 1 queued at a portal · 2 transitioning (reserved: stairs) · 3 exited. */
export type ActorFlag = 0 | 1 | 2 | 3;
export const ACTOR_MOVING = 0;
export const ACTOR_QUEUED = 1;
export const ACTOR_TRANSITIONING = 2;
export const ACTOR_EXITED = 3;

/** One decoded simulation frame. Actor indices are stable for a whole run. */
export interface ActorFrame {
  tick: number;
  /** [x0, y0, x1, y1, …] in world meters. */
  actorXY: Float32Array;
  actorFlags: Uint8Array;
  /** Floor index in floorsByLevel(snapshot), and feet height in metres. Absent in v1 ground-floor replays. */
  actorFloor?: Uint16Array;
  actorElevation?: Float32Array;
}

/** A decoded replay chunk (2 s = 20 frames at 10 Hz). */
export interface ReplayChunk {
  actorCount: number;
  firstTick: number;
  frames: ActorFrame[];
}

export interface ScalarField {
  fieldId: FieldId;
  aggregation: Aggregation;
  grid: GridDefinition;
  units: string;
  /** Row-major, i = y * width + x. NaN = not walkable (masked). */
  values: Float32Array;
}

export const MULTIFLOOR_MODEL_VERSION = '0.3.0';
export const TICK_RATE_HZ = 10;
export const DT_SECONDS = 0.1;
export const CELL_SIZE_M = 0.25;
export const FRAMES_PER_CHUNK = 20;
