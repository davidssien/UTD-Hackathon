/**
 * Contra V1 cross-boundary domain contracts.
 * Pure TypeScript. No imports from Next.js, Konva, SpacetimeDB, or Node.
 * Domain contracts are not the generated SpacetimeDB SDK signatures.
 * Runtime validation (e.g. Zod) must mirror these types at every trust boundary.
 */

export type ID = string;
export type Vec2 = { x: number; y: number }; // world meters, +y upwards
export type AngleRad = number; // counterclockwise
export type WallMaterial = 'normal' | 'reinforced' | 'glass';
export type ActorFlag = 0 | 1 | 2 | 3; // moving, waiting, transitioning, exited

export interface Transform2D { position: Vec2; rotationRad: AngleRad }
export type Footprint2D =
  | { kind: 'rectangle'; widthM: number; depthM: number }
  | { kind: 'circle'; radiusM: number }
  | { kind: 'polygon'; vertices: Vec2[] }; // local coordinates

export interface Floor {
  id: ID;
  level: number;
  name: string;
  elevationM: number;
  ceilingHeightM: number;
  boundary: Vec2[]; // ordered, closed implicitly, non-self-intersecting
}
export interface Vertex { id: ID; floorId: ID; position: Vec2 }

export interface Wall {
  kind: 'wall';
  id: ID;
  floorId: ID;
  startVertexId: ID;
  endVertexId: ID;
  thicknessM: number;
  heightM: number;
  material: WallMaterial;
  renderOrder: number;
}
export interface Opening {
  kind: 'opening';
  id: ID;
  floorId: ID;
  wallId: ID;
  openingKind: 'door' | 'window' | 'exit';
  offsetM: number; // center distance from wall start, measured along wall
  widthM: number;
  sillHeightM: number;
  openingHeightM: number;
  state: 'open' | 'closed';
  renderOrder: number;
}
export type FurnitureType = 'table' | 'chair' | 'desk' | 'shelf' | 'countertop' | 'column' | 'vending-machine';
export interface Furniture {
  kind: 'furniture';
  id: ID;
  floorId: ID;
  furnitureType: FurnitureType;
  prefabId?: ID;
  transform: Transform2D;
  footprint: Footprint2D;
  zMinM: number;
  zMaxM: number;
  blocksPedestrians: boolean;
  airPermeability: number; // [0,1]; future 2D approximation only
  renderOrder: number;
  parameters: Record<string, number | boolean | string>;
}
export interface Fixture {
  kind: 'fixture';
  id: ID;
  floorId: ID;
  fixtureType: 'extinguisher' | 'sprinkler' | 'alarm' | 'vent';
  prefabId?: ID;
  transform: Transform2D;
  zMinM: number;
  zMaxM: number;
  renderOrder: number;
  hvacTerminalId?: ID;
}
export type Entity = Wall | Opening | Furniture | Fixture;

export interface DuctNode { id: ID; floorId: ID; position: Vec2; zM: number }
export interface DuctEdge {
  id: ID;
  fromNodeId: ID;
  toNodeId: ID;
  widthM: number;
  heightM: number;
}
export interface AirTerminal {
  id: ID;
  floorId: ID;
  ductNodeId?: ID;
  position: Vec2;
  zM: number;
  terminalKind: 'supply' | 'return' | 'exhaust';
  flowM3PerSecond: number;
  direction: Vec2; // normalised 2D, if applicable
  enabled: boolean;
}
export interface HVACSystem {
  id: ID;
  name: string;
  nodes: DuctNode[];
  edges: DuctEdge[];
  terminals: AirTerminal[];
}
export interface FloorConnection {
  id: ID;
  fromFloorId: ID;
  toFloorId: ID;
  fromPosition: Vec2;
  toPosition: Vec2;
  connectionKind: 'stairs' | 'ramp' | 'elevator';
  widthM: number;
  capacityPersonsPerSecond: number;
  travelTimeSeconds: number;
  direction: 'both' | 'forward' | 'backward';
}
export interface BuildingDocument {
  schemaVersion: 1;
  projectId: ID;
  revision: number;
  floors: Floor[];
  vertices: Vertex[];
  entities: Entity[];
  hvacSystems: HVACSystem[];
  floorConnections: FloorConnection[];
}

export type PrefabGenerator = 'rigid' | 'linear-stretch' | 'wall-hosted';
export interface PrefabDefinition {
  prefabId: ID;
  name: string;
  category: string;
  visualAssetPath: string;
  generator: PrefabGenerator;
  footprint: Footprint2D;
  defaults: Record<string, number | string | boolean>;
  placement: {
    snapToWall: boolean;
    canRotate: boolean;
    preventOverlap: boolean;
    minLengthM?: number;
    maxLengthM?: number;
    minClearanceM?: number;
  };
}

// Population painting is scenario data: it does not modify BuildingDocument.
export interface PopulationBrushStroke {
  id: ID;
  floorId: ID;
  points: Vec2[]; // polyline of sampled brush centers, in world meters
  radiusM: number;
  mode: 'set' | 'increase' | 'decrease' | 'erase';
  weight: number; // [0,4] for 'set'; bounded increment for increase/decrease
  falloff: 'flat' | 'linear';
}
export type PopulationCount =
  | { mode: 'fixed'; people: number }
  | {
      mode: 'daily-curve';
      minPeople: number;
      maxPeople: number;
      peakHour: number;
      halfWidthHours: number;
      selectedHour: number;
    };
export interface PopulationDefinition {
  count: PopulationCount;
  distribution: 'uniform' | 'painted';
  strokes: PopulationBrushStroke[];
  seed: number;
}
export type ScenarioGoal =
  | { kind: 'evacuate'; allowedExitIds?: ID[]; blockedExitIds: ID[] }
  | { kind: 'circulate'; turnoverPerHour: number; dwellSeconds: number };
export interface SimulationScenario {
  schemaVersion: 1;
  id: ID;
  projectId: ID;
  name: string;
  population: PopulationDefinition;
  goal: ScenarioGoal;
  durationSeconds: number;
}

export interface GridDefinition {
  floorId: ID;
  origin: Vec2;
  cellSizeM: number; // 0.25 in MVP
  width: number;
  height: number;
}
export interface NavigationPortal {
  id: ID;
  floorId: ID;
  kind: 'door' | 'exit' | 'stairs';
  position: Vec2;
  widthM: number;
  capacityPersonsPerSecond: number;
  destinationFloorId?: ID;
  destinationPosition?: Vec2;
}
export interface CompiledFloor {
  grid: GridDefinition;
  walkableMask: Uint8Array;
  walkableFraction: Float32Array;
  navigationRegionIds: Int32Array; // crossing open door possible
  paintCompartmentIds: Int32Array; // door thresholds separate brush compartments
  airFaceX: Float32Array; // (width+1)*height; reserved for airflow
  airFaceY: Float32Array; // width*(height+1); reserved for airflow
  portals: NavigationPortal[];
}
export interface FrozenSimulationInput {
  schemaVersion: 1;
  runId: ID;
  document: BuildingDocument;
  layoutHash: string;
  scenario: SimulationScenario;
  config: SimulationConfig;
}
export interface SimulationConfig {
  tickRateHz: 10;
  cellSizeM: 0.25;
  modelId: string; // e.g. 'contra-pedestrian'
  modelVersion: string;
  seed: number;
  maxTicks: number;
  execution: 'server-cpu' | 'client-cpu' | 'server-gpu' | 'client-gpu';
}
export interface ActorInitialState {
  actorId: number;
  floorId: ID;
  position: Vec2;
  radiusM: number;
  preferredSpeedMps: number;
  targetExitId: ID | null;
}
export type FieldId =
  | 'people.density' | 'people.speed' | 'people.congestion'
  | 'people.velocity' | 'people.routeDemand' | 'people.exitDistance'
  | 'air.velocity' | 'air.flowMagnitude' | 'smoke.concentration';
export type Aggregation = 'instant' | 'timeAverage' | 'perCellPeak';
export interface ScalarFieldFrame {
  runId: ID;
  tick: number;
  floorId: ID;
  grid: GridDefinition;
  fieldId: Exclude<FieldId, 'people.velocity' | 'air.velocity'>;
  aggregation: Aggregation;
  units: string;
  values: Float32Array; // row-major: i=y*width+x
}
export interface VectorFieldFrame {
  runId: ID;
  tick: number;
  floorId: ID;
  grid: GridDefinition;
  fieldId: 'people.velocity' | 'air.velocity';
  aggregation: Aggregation;
  units: string;
  x: Float32Array;
  y: Float32Array;
}
export type FieldFrame = ScalarFieldFrame | VectorFieldFrame;
export interface ActorFrame {
  runId: ID;
  tick: number;
  simulatedSeconds: number;
  actorCount: number;
  actorXY: Float32Array; // [x,y] each actor, stable index throughout run
  actorFlags: Uint8Array; // ActorFlag; actor indices stable
  actorFloorIndices?: Uint8Array;
}
export interface BottleneckMetric {
  floorId: ID;
  regionCenter: Vec2;
  score: number;
  observedAtTick?: number;
  fieldId: FieldId;
  description?: string;
}
export interface SimulationMetrics {
  runId: ID;
  tick: number;
  simulatedSeconds: number;
  initialPeople: number;
  evacuatedPeople: number;
  remainingPeople: number;
  unreachablePeople: number;
  maxQueueLength: number;
  meanCongestion: number;
  peakCongestion: number;
  perExitThroughput: Record<ID, number>;
  bottlenecks: BottleneckMetric[];
  complete: boolean;
}
export type SimulationRunStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
export interface SimulationRunRecord {
  runId: ID;
  projectId: ID;
  layoutRevision: number;
  layoutHash: string;
  scenarioId: ID;
  scenarioSnapshot: SimulationScenario;
  modelId: string;
  modelVersion: string;
  seed: number;
  tickRateHz: 10;
  cellSizeM: 0.25;
  status: SimulationRunStatus;
  execution: SimulationConfig['execution'];
  verification: 'unverified' | 'server-verified';
  errorCode?: string;
}
export interface ReplayChunkMeta {
  runId: ID;
  chunkIndex: number;
  firstTick: number;
  lastTick: number;
  encoding: 'gzip-binary-v1';
  uncompressedBytes: number;
  compressedBytes: number;
  storage: 'spacetimedb' | 'object-store';
  objectKey?: string;
}

// Semantic editing operations; actual SpacetimeDB reducers enforce auth/revision.
export type EditCommand =
  | { kind: 'createWall'; floorId: ID; from: Vec2; to: Vec2; thicknessM: number; heightM: number; material: WallMaterial }
  | { kind: 'moveVertex'; vertexId: ID; newPosition: Vec2 }
  | { kind: 'deleteEntity'; entityId: ID }
  | { kind: 'createOpening'; floorId: ID; wallId: ID; openingKind: Opening['openingKind']; offsetM: number; widthM: number; sillHeightM: number; openingHeightM: number; state: Opening['state'] }
  | { kind: 'updateOpening'; entityId: ID; patch: Partial<Pick<Opening, 'offsetM' | 'widthM' | 'state'>> }
  | { kind: 'placeFurniture'; floorId: ID; furnitureType: FurnitureType; prefabId?: ID; transform: Transform2D; footprint: Footprint2D }
  | { kind: 'transformFurniture'; entityId: ID; transform: Transform2D }
  | { kind: 'updateWall'; entityId: ID; patch: Partial<Pick<Wall, 'thicknessM' | 'heightM' | 'material'>> };
export interface EditRequest {
  projectId: ID;
  expectedRevision: number;
  requestId: ID; // idempotency/dedup where implemented
  commands: EditCommand[]; // atomic batch
}
export type DomainErrorCode =
  | 'UNAUTHORIZED' | 'NOT_FOUND' | 'REVISION_CONFLICT'
  | 'INVALID_GEOMETRY' | 'OBJECT_COLLISION' | 'OPENING_OUTSIDE_WALL'
  | 'NO_REACHABLE_EXIT' | 'POPULATION_INFEASIBLE' | 'RUN_LIMIT_EXCEEDED'
  | 'INVALID_SCENARIO' | 'UNSUPPORTED_MODEL' | 'INTERNAL_ERROR';
export interface DomainError { code: DomainErrorCode; message: string; details?: Record<string, unknown> }

// WebSocket control messages. Binary actor/field payload is described in spec.
export type ViewerToRunnerMessage =
  | { protocolVersion: 1; type: 'AUTH_STREAM'; runId: ID; identityToken: string }
  | { protocolVersion: 1; type: 'PAUSE_RUN' | 'RESUME_RUN' | 'STOP_RUN'; runId: ID }
  | { protocolVersion: 1; type: 'SEEK_REPLAY'; runId: ID; tick: number };
export type RunnerToViewerMessage =
  | { protocolVersion: 1; type: 'AUTH_OK'; runId: ID }
  | { protocolVersion: 1; type: 'RUN_STATUS'; runId: ID; status: SimulationRunStatus }
  | { protocolVersion: 1; type: 'FRAME_HEADER' | 'FIELD_HEADER'; runId: ID; sequence: number; tick: number; byteLength: number }
  | { protocolVersion: 1; type: 'METRICS'; runId: ID; metrics: SimulationMetrics }
  | { protocolVersion: 1; type: 'RUN_COMPLETE'; runId: ID; metrics: SimulationMetrics }
  | { protocolVersion: 1; type: 'ERROR'; runId: ID; error: DomainError };

export interface GeometryDiagnostic {
  level: 'info' | 'warning' | 'error';
  code: string;
  entityIds: ID[];
  message: string;
}
export interface AgentProposal {
  id: ID;
  projectId: ID;
  baseRevision: number;
  agentJobId: ID;
  commands: EditCommand[];
  baselineRunId: ID;
  candidateRunId?: ID;
  explanation: string;
  measuredDelta: Record<string, number>;
  status: 'proposed' | 'accepted' | 'rejected';
}
