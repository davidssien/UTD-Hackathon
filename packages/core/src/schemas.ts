/**
 * Zod schemas: the single source of truth for every JSON shape that crosses a
 * trust boundary (browser ⇄ SpacetimeDB ⇄ runner ⇄ agent). TypeScript types in
 * `types.ts` are inferred from these. See Plan.md §4.
 *
 * Conventions: meters, plan coordinates {x, y} with +y = north, radians CCW.
 */
import { z } from 'zod';

// ── Primitives ──────────────────────────────────────────────────────────────

export const IdSchema = z.string().min(1).max(160);
export const Vec2Schema = z.object({ x: z.number(), y: z.number() });
export const WallMaterialSchema = z.enum(['normal', 'reinforced', 'glass']);
export const OpeningKindSchema = z.enum(['door', 'window', 'exit']);
export const OpeningStateSchema = z.enum(['open', 'closed']);
export const RoleSchema = z.enum(['owner', 'editor', 'viewer']);

// ── Entities (EgressDocument v1) ────────────────────────────────────────────

export const FloorSchema = z.object({
  kind: z.literal('floor'),
  id: IdSchema,
  level: z.number().int(),
  name: z.string().max(80),
  elevationM: z.number(),
  ceilingHeightM: z.number().positive().max(50),
});

export const VertexSchema = z.object({
  kind: z.literal('vertex'),
  id: IdSchema,
  floorId: IdSchema,
  position: Vec2Schema,
});

export const WallSchema = z.object({
  kind: z.literal('wall'),
  id: IdSchema,
  floorId: IdSchema,
  startVertexId: IdSchema,
  endVertexId: IdSchema,
  thicknessM: z.number().positive().max(2),
  heightM: z.number().positive().max(50),
  material: WallMaterialSchema,
  /**
   * Visual finish (texture) id from a future finishes registry, per side of the
   * wall relative to start→end. Purely visual: physics uses `material` and geometry only.
   */
  finish: z.object({ left: z.string().max(80).optional(), right: z.string().max(80).optional() }).optional(),
});

export const OpeningSchema = z.object({
  kind: z.literal('opening'),
  id: IdSchema,
  floorId: IdSchema,
  wallId: IdSchema,
  openingKind: OpeningKindSchema,
  /** Center of the opening, measured along the wall from its start vertex. */
  offsetM: z.number().nonnegative(),
  widthM: z.number().positive().max(20),
  sillHeightM: z.number().nonnegative(),
  openingHeightM: z.number().positive().max(50),
  state: OpeningStateSchema,
});

export const EntitySchema = z.discriminatedUnion('kind', [FloorSchema, VertexSchema, WallSchema, OpeningSchema]);

export const EgressDocumentSchema = z.object({
  docVersion: z.literal(1),
  projectId: IdSchema,
  revision: z.number().int().nonnegative(),
  floors: z.array(FloorSchema),
  vertices: z.array(VertexSchema),
  walls: z.array(WallSchema),
  openings: z.array(OpeningSchema),
  /** Reserved until the furniture pass. */
  furniture: z.array(z.never()),
});

// ── Edit commands ───────────────────────────────────────────────────────────

const WallStyle = {
  thicknessM: WallSchema.shape.thicknessM,
  heightM: WallSchema.shape.heightM,
  material: WallMaterialSchema,
};

export const EditCommandSchema = z.discriminatedUnion('kind', [
  /** Pen tool: consecutive points become walls sharing vertices. */
  z.object({ kind: z.literal('createWallChain'), floorId: IdSchema, points: z.array(Vec2Schema).min(2).max(256), ...WallStyle }),
  /** Box tool: 4 vertices + 4 walls with shared corners. */
  z.object({ kind: z.literal('createBox'), floorId: IdSchema, min: Vec2Schema, max: Vec2Schema, ...WallStyle }),
  /** Erase tool: deletes every wall piece the segment crosses, plus its openings. */
  z.object({ kind: z.literal('eraseByLine'), floorId: IdSchema, from: Vec2Schema, to: Vec2Schema }),
  z.object({ kind: z.literal('moveVertex'), vertexId: IdSchema, to: Vec2Schema }),
  z.object({
    kind: z.literal('updateWall'),
    wallId: IdSchema,
    patch: z.object({
      thicknessM: WallStyle.thicknessM.optional(),
      heightM: WallStyle.heightM.optional(),
      material: WallMaterialSchema.optional(),
      finish: WallSchema.shape.finish,
    }),
  }),
  z.object({
    kind: z.literal('createOpening'),
    wallId: IdSchema,
    openingKind: OpeningKindSchema,
    offsetM: z.number().nonnegative(),
    widthM: OpeningSchema.shape.widthM,
    sillHeightM: z.number().nonnegative().optional(),
    openingHeightM: OpeningSchema.shape.openingHeightM.optional(),
    state: OpeningStateSchema.optional(),
  }),
  z.object({
    kind: z.literal('updateOpening'),
    openingId: IdSchema,
    patch: z.object({
      offsetM: z.number().nonnegative().optional(),
      widthM: OpeningSchema.shape.widthM.optional(),
      state: OpeningStateSchema.optional(),
      openingKind: OpeningKindSchema.optional(),
    }),
  }),
  z.object({ kind: z.literal('deleteEntities'), ids: z.array(IdSchema).min(1).max(5000) }),
  /** Generic put/remove. Used for undo/redo, imports and agent proposals. */
  z.object({ kind: z.literal('applyPatch'), put: z.array(EntitySchema).max(5000), remove: z.array(IdSchema).max(5000) }),
]);

export const EditRequestSchema = z.object({
  projectId: IdSchema,
  /** Unique per request. New entity IDs derive from it: `${requestId}.${n}`. */
  requestId: IdSchema,
  baseRevision: z.number().int().nonnegative(),
  commands: z.array(EditCommandSchema).min(1).max(64),
});

// ── Scenarios ───────────────────────────────────────────────────────────────

export const PopulationBrushStrokeSchema = z.object({
  id: IdSchema,
  floorId: IdSchema,
  /** Polyline of sampled brush centers, world meters. */
  points: z.array(Vec2Schema).min(1).max(4096),
  radiusM: z.number().positive().max(25),
  mode: z.enum(['set', 'increase', 'decrease', 'erase']),
  /** [0,4] for `set`; bounded delta for increase/decrease; ignored for erase. */
  weight: z.number().min(-4).max(4),
  falloff: z.enum(['flat', 'linear']),
});

export const ScenarioGoalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('evacuate'), blockedExitIds: z.array(IdSchema).max(256) }),
]);

export const SimulationScenarioSchema = z.object({
  scenarioVersion: z.literal(1),
  id: IdSchema,
  projectId: IdSchema,
  name: z.string().min(1).max(80),
  population: z.object({
    count: z.number().int().min(1).max(5000),
    distribution: z.enum(['uniform', 'painted']),
    strokes: z.array(PopulationBrushStrokeSchema).max(500),
    seed: z.number().int().min(0).max(0xffffffff),
  }),
  goal: ScenarioGoalSchema,
  /**
   * Live-mode elements placed for this run (reserved). Changing them restarts the
   * run. egress-pedestrian v0.1 ignores them; a future fire/smoke model reads them.
   */
  elements: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('fire'), id: IdSchema, floorId: IdSchema, position: Vec2Schema, radiusM: z.number().positive().max(20), startSeconds: z.number().nonnegative() }),
  ])).max(50).optional(),
  /** Timeout in simulated seconds. */
  durationSeconds: z.number().positive().max(3600),
});

// ── Runs, fields, metrics ───────────────────────────────────────────────────

/** `x1|x2|x4` = paced against the wall clock (LIVE edge grows visibly); `unpaced` = as fast as possible. */
export const PaceSchema = z.enum(['x1', 'x2', 'x4', 'unpaced']);
export const RunStatusSchema = z.enum(['queued', 'running', 'complete', 'failed', 'cancelled']);

export const FieldIdSchema = z.enum([
  'people.density',
  'people.speed',
  'people.congestion',
  'people.exitDistance',
  // reserved
  'people.velocity',
  'people.routeDemand',
  'air.velocity',
  'air.flowMagnitude',
  'smoke.concentration',
]);
export const AggregationSchema = z.enum(['instant', 'timeAverage', 'perCellPeak']);

export const GridDefinitionSchema = z.object({
  floorId: IdSchema,
  origin: Vec2Schema,
  cellSizeM: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const BottleneckMetricSchema = z.object({
  floorId: IdSchema,
  regionCenter: Vec2Schema,
  score: z.number(),
  observedAtTick: z.number().int().nonnegative().optional(),
  fieldId: FieldIdSchema,
  description: z.string().max(400).optional(),
});

export const SimulationMetricsSchema = z.object({
  runId: IdSchema,
  tick: z.number().int().nonnegative(),
  simulatedSeconds: z.number().nonnegative(),
  initialPeople: z.number().int().nonnegative(),
  evacuatedPeople: z.number().int().nonnegative(),
  remainingPeople: z.number().int().nonnegative(),
  unreachablePeople: z.number().int().nonnegative(),
  /** Simulated seconds until the last reachable person exited; null while running or if timed out. */
  evacuationTimeSeconds: z.number().nonnegative().nullable(),
  maxQueueLength: z.number().int().nonnegative(),
  meanCongestion: z.number().nonnegative(),
  peakCongestion: z.number().nonnegative(),
  perExitThroughput: z.record(IdSchema, z.number().int().nonnegative()),
  bottlenecks: z.array(BottleneckMetricSchema).max(32),
  complete: z.boolean(),
});

// ── Agent ───────────────────────────────────────────────────────────────────

export const AgentStepKindSchema = z.enum(['thought', 'tool_call', 'tool_result', 'message', 'error']);
export const ProposalStatusSchema = z.enum(['proposed', 'accepted', 'rejected', 'stale']);

export const AgentContextSchema = z.object({
  selectedEntityIds: z.array(IdSchema).max(64).optional(),
  runId: IdSchema.optional(),
  tick: z.number().int().nonnegative().optional(),
});

export const ProposalNotesSchema = z.object({
  /** Command index (as string) → why the agent suggested it. Rendered as bubbles next to the ghost entities. */
  byCommand: z.record(z.string(), z.string().max(600)),
  summary: z.string().max(2000),
});
