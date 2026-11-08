/**
 * Zod schemas: the single source of truth for every JSON shape that crosses a
 * trust boundary (browser ⇄ SpacetimeDB ⇄ runner ⇄ agent). TypeScript types in
 * `types.ts` are inferred from these. See docs/ARCHITECTURE.md §4.
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
/** Floor surface finishes (D74). 'basic' uses the plain wall look. Visual only; walkability comes from geometry. */
export const SlabMaterialSchema = z.enum(['wood', 'basic', 'tile']);
export const StairEdgeSchema = z.enum(['n', 'e', 's', 'w']);

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

/** A floor surface (D74): a polygon on one floor with a finish. On upper floors only slabs are walkable. */
export const SlabSchema = z.object({
  kind: z.literal('slab'),
  id: IdSchema,
  floorId: IdSchema,
  polygon: z.array(Vec2Schema).min(3).max(128),
  material: SlabMaterialSchema,
});

/**
 * A straight stair (D75): a rectangle on `floorId` rising to `toFloorId` (the next floor up).
 * `upEdge` is the side of the rectangle at the top; people evacuate down it.
 */
export const StairSchema = z.object({
  kind: z.literal('stair'),
  id: IdSchema,
  floorId: IdSchema,
  toFloorId: IdSchema,
  min: Vec2Schema,
  max: Vec2Schema,
  upEdge: StairEdgeSchema,
});

/** Furniture and fixtures (final sprint, D88): rotated about the vertical axis only. See core/placeables.ts for sizes. */
export const PlaceableItemSchema = z.enum(['table', 'desk', 'chair', 'counter', 'vent']);
export const PlaceableSchema = z.object({
  kind: z.literal('placeable'),
  id: IdSchema,
  floorId: IdSchema,
  item: PlaceableItemSchema,
  position: Vec2Schema,
  rotationDeg: z.number().min(-360).max(360),
});

export const EntitySchema = z.discriminatedUnion('kind', [FloorSchema, VertexSchema, WallSchema, OpeningSchema, SlabSchema, StairSchema, PlaceableSchema]);

export const EgressDocumentSchema = z.object({
  docVersion: z.literal(1),
  projectId: IdSchema,
  revision: z.number().int().nonnegative(),
  floors: z.array(FloorSchema),
  vertices: z.array(VertexSchema),
  walls: z.array(WallSchema),
  openings: z.array(OpeningSchema),
  /** Floor surfaces and stairs (D74, D75). Older documents have none. */
  slabs: z.array(SlabSchema).default([]),
  stairs: z.array(StairSchema).default([]),
  placeables: z.array(PlaceableSchema).default([]),
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
  /** Floor tool (D74): a surface from a drawn rectangle or a filled room outline. */
  z.object({ kind: z.literal('createSlab'), floorId: IdSchema, polygon: z.array(Vec2Schema).min(3).max(128), material: SlabMaterialSchema }),
  z.object({ kind: z.literal('updateSlab'), slabId: IdSchema, patch: z.object({ material: SlabMaterialSchema.optional(), polygon: z.array(Vec2Schema).min(3).max(128).optional() }) }),
  /** A new floor on top; its elevation is the floor below plus that floor's floor-to-floor height. */
  z.object({ kind: z.literal('createFloor'), name: z.string().trim().min(1).max(80), ceilingHeightM: z.number().positive().max(50).optional() }),
  /** Changing a floor-to-floor height moves every floor above it. */
  z.object({ kind: z.literal('updateFloor'), floorId: IdSchema, patch: z.object({ name: z.string().trim().min(1).max(80).optional(), ceilingHeightM: z.number().min(2).max(50).optional() }) }),
  z.object({ kind: z.literal('createStair'), floorId: IdSchema, min: Vec2Schema, max: Vec2Schema, upEdge: StairEdgeSchema }),
  z.object({ kind: z.literal('updateStair'), stairId: IdSchema, patch: z.object({ upEdge: StairEdgeSchema.optional(), min: Vec2Schema.optional(), max: Vec2Schema.optional() }) }),
  z.object({ kind: z.literal('createPlaceable'), floorId: IdSchema, item: PlaceableItemSchema, position: Vec2Schema, rotationDeg: z.number().min(-360).max(360).optional() }),
  z.object({ kind: z.literal('updatePlaceable'), placeableId: IdSchema, patch: z.object({ position: Vec2Schema.optional(), rotationDeg: z.number().min(-360).max(360).optional() }) }),
  /** Generic put/remove. Used for undo/redo, imports and agent proposals. */
  z.object({ kind: z.literal('applyPatch'), expectedLayoutHash: z.string().length(64).optional(), put: z.array(EntitySchema).max(5000), remove: z.array(IdSchema).max(5000) }),
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
  /** Assumed exterior wind for airflow and smoke (default west). */
  windFrom: z.enum(['west', 'north', 'east', 'south']).optional(),
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
  perFloor: z.record(IdSchema, z.object({
    started: z.number().int().nonnegative(), exitedHere: z.number().int().nonnegative(), stairDescents: z.number().int().nonnegative(),
  })).optional(),
  bottlenecks: z.array(BottleneckMetricSchema).max(32),
  complete: z.boolean(),
  /** all-out: every reachable person left; stabilized: nothing changed for 10 s (people trapped or stalled); timeout: safety cap. */
  endReason: z.enum(['all-out', 'stabilized', 'timeout']).optional(),
  /** Exit choice v0.2: total exit switches, and switches back to an exit the person had left (A→B→A). */
  exitSwitches: z.number().int().nonnegative().optional(),
  exitReversals: z.number().int().nonnegative().optional(),
  /** Hazard runs: people overcome inside the flames, and by cumulative smoke exposure. */
  fireDeaths: z.number().int().nonnegative().optional(),
  smokeDeaths: z.number().int().nonnegative().optional(),
});

// ── Agent ───────────────────────────────────────────────────────────────────

export const AgentStepKindSchema = z.enum(['thought', 'tool_call', 'tool_result', 'message', 'error']);
export const ProposalStatusSchema = z.enum(['proposed', 'accepted', 'rejected', 'stale']);

export const AgentContextSchema = z.object({
  floorId: IdSchema.optional(),
  windFrom: z.enum(['west', 'north', 'east', 'south']).optional(),
  selectedEntityIds: z.array(IdSchema).max(64).optional(),
  runId: IdSchema.optional(),
  tick: z.number().int().nonnegative().optional(),
});

export const ProposalNotesSchema = z.object({
  /** Command index (as string) → why the agent suggested it. Rendered as bubbles next to the ghost entities. */
  byCommand: z.record(z.string(), z.string().max(600)),
  summary: z.string().max(2000),
});
