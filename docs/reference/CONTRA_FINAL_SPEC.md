# CONTRA — FINAL HACKATHON BUILD SPECIFICATION

**Version:** 1.0 · **Date:** 2026-11-07 · **Audience:** the four-person team and Claude Code · **Duration:** 24-hour hackathon

> **One-sentence pitch:** Contra is a collaborative 2D building editor in which users can paint where people start, run a real pedestrian-flow simulation, see congestion accumulate, replay the experiment, and let a Nemotron agent test design changes against measured outcomes.
>
> **Core demo:** Open a recognizable model of the hackathon venue → adjust one wall/door → paint a crowd across a room → choose **Evacuate** → press Play → watch individuals queue at narrow passages while a heatmap develops → inspect replay and bottleneck metrics → Nemotron tests an improvement and presents verified before/after results.

## 0. Decisions that are frozen

| Decision | Frozen implementation |
|---|---|
| Language | End-to-end TypeScript, Node.js 22+ |
| Web | Next.js + React + React-Konva |
| Main backend | SpacetimeDB 2.x **TypeScript module** |
| Compute | Dedicated Node.js simulation/agent worker; no heavy per-pedestrian transactions in SpacetimeDB |
| Visualization | Browser renders data frames; server never renders images |
| Geometry | Continuous 2D vector geometry, no curves in MVP; straight and diagonal walls |
| Grid | 0.25 m simulation cells; not the canonical source geometry |
| Height | `zMinM`/`zMaxM` (physical) separate from `renderOrder` (visual) |
| Wall types | `normal`, `reinforced`, `glass`; physically identical in MVP |
| Furniture | `table`, `chair`, `desk`, `shelf`, `countertop`, `column`; rectangle/circle footprints |
| Editor | Pencil/click-to-connect walls; pointer placement/selection/move/rotate; opening placement; right-click properties |
| Simulation | Discrete pedestrians + collision/door capacity; fixed 10 Hz; renderer interpolates at display rate |
| Population | User specifies total count; starts uniform; Live mode brush paints **relative initial density** |
| Paint behavior | Brush cannot bleed through walls; overlapping compartments are split; NPCs later route independently |
| Modes | Design (static analysis), Live (simulate), Analysis (replay/compare) |
| Principal scenario | Evacuation; simple everyday traffic only after evacuation is reliable |
| Data | SpacetimeDB owns projects, groups, edits, scenarios, runs, results, agent jobs |
| AI | NVIDIA Nemotron tool-using investigation agent, never sole source of physics metrics |
| Safety | Exploratory flow model, **not** architectural/fire-code certification |

### Must work vs. extension

**P0, demo-critical:** save/load, wall/door/exit/furniture editing, group sharing, structural heatmap, painted population, 10 Hz evacuation, congestion heatmap, run completion, basic replay, Nemotron actually invoking tools.

**P1:** before/after proposal, side-by-side results, traffic scenario, right-click per-vent flow configuration, HVAC duct sketches, three random-seed comparison.

**Do not build during MVP:** 3D, curved walls, precise CFD, actual fire spread, full-day 864,000-tick runs, parking generator, fully automatic room generation, regulatory claims, GPU-only compute. Reserve data extensions but do not commit unfinished features.

## 1. Screen and interaction behavior

### 1.1 Project dashboard
- Sign in anonymously (development/demo identity); saved projects appear on return with the same token.
- Create project, open existing project, join group via invitation, create group.
- Group members can share and edit projects according to owner/editor/viewer permissions.
- Two browser tabs viewing a project see accepted edits via SpacetimeDB subscriptions.

### 1.2 Design mode
- **Pencil:** click start → click next endpoint creates a straight wall; repeated clicks extend a wall chain. Diagonals are valid. Escape ends chain; snapping to existing vertices is supported.
- **Selection:** click select, drag move when allowed; wall endpoints have handles; right-click opens Configure/Duplicate/Delete/Material.
- **Wall type:** normal, reinforced, glass (colors/patterns vary, same collision/air barrier in MVP).
- **Placement:** doors/exits/windows snap to a host wall; furniture places as generic footprint/prefab instance; walls are not furniture prefabs.
- **Properties:** type, thickness, geometry, placement, door state, dimensions, fixture settings.
- **Continuous feedback:** debounce a lightweight structural exit-distance and passage-demand analysis after valid geometry edits (approximately 150–350 ms). This is NOT a dynamic crowd simulation.
- A footprint is valid when closed, non-self-intersecting, and has at least one accessible designated exit for evacuation analysis. The editor may still save an invalid draft; simulations show diagnostics rather than crashing.

### 1.3 Live mode
- Choose scenario: **Evacuate** (P0), **Circulate** (P1).
- Choose total persons N (e.g. 300), seed, run duration, optional selected time of day.
- Starts with an **even distribution over walkable area** (not across walls/furniture).
- Select a density paint tool; brush radius in meters, density weight, increase/decrease/reset. Painting changes **starting probabilities**, not total N.
- Brush is rendered above the building as a translucent input layer. On a wall separating rooms, a brush overlap becomes independent patches on each side; smoothing and flood fill do not cross solid barriers or door thresholds for paint. People can still travel through doors once simulated.
- Press Play: immutable geometry and paint are snapshotted into a run. Pedestrians spawn once, get individual routes toward accessible exits, and move at fixed 10 Hz.
- Live worker streams actor state frames and less frequent heatmap fields; browser interpolates actors at ~60 FPS, allows pause/resume and speed controls.
- On completion show **accumulated time-averaged congestion** as default; final instantaneous density alone would wrongly show an empty evacuated building.

### 1.4 Analysis mode
- List saved experiments per project and their source building revision, model version, parameters, and verification status.
- Replay from compressed state-frame chunks with a scrubber; heatmap options: **current**, **time average**, **peak per cell**. Note local peaks might occur at different times.
- Show evacuation time, people evacuated/remaining, max queue, congestion regions, throughput per exit, unreachable spaces.
- Compare baseline and a modified scenario with same seed and starting positions when geometry permits. Disallow placements that overlap initial actors or explicitly reinitialize affected actors and label the comparison less controlled.
- Nemotron sidebar has context: selected object, project revision, scenario/run, metric(s), optionally selected playback tick.

## 2. Repositories, boundaries, ownership

```text
contra/
  apps/web/                  # Next.js, editor, modes, renderer, Spacetime client
  packages/contracts/       # Types + Zod validation; stable pure TS (source of truth)
  packages/geometry/        # Exact vector operations + grid compiler
  packages/simulation/      # Pure deterministic CPU model + frame codecs
  packages/prefabs/         # SVG, asset registry, procedural footprints
  spacetimedb/src/          # Main backend module and public/private views
  services/runner/          # Node.js simulation worker, websocket, replay writer
  services/agent/           # Nemotron loop (may run in same Node process as runner)
  content/prefabs/          # SVG + JSON per asset
  content/scenes/           # Venue + small test scenes
  docs/                     # This spec and example fixtures
```

**Rules:**
- `packages/contracts` imports no app, database, or browser libraries. Types and schema version live here.
- `packages/geometry` depends on contracts, not Konva.
- `packages/simulation` depends on contracts/geometry, not SpacetimeDB, Node APIs, GPU, or React.
- SpacetimeDB reducers own authorization and authoritative mutation. The Node runner is authorized only for simulation/job/result reducers.
- The Next.js app is a client and asset host, **not a second CRUD database backend**.
- Shared pure code can be reused in SpacetimeDB where supported, but avoid depending on browser or Node-specific APIs inside modules.

## 3. Exact spatial conventions

- `x`,`y` lie on a floor plane in **meters**, right-handed drawing coordinate logic; world `y` increases upwards. Convert to screen `y` in the rendering adapter (screen `y` usually increases downwards).
- Angles use **radians CCW in world coordinates**.
- Each floor has `floorId`, `level`, `elevationM`, `ceilingHeightM`, `boundary: Polygon`.
- Vertices are shared between connected wall segments; entity IDs never change while editing.
- Geometry accepts floating coordinates; snapping defaults to **0.25 m**, and can be disabled.
- Only straight wall centerlines are supported (arbitrary angles), each with thickness and height.
- `renderOrder` determines visual draw order. `zMinM,zMaxM` define physical height. A low table blocks people but may be bypassed above its height in a future airflow model; wall is floor-to-ceiling.
- Physical barrier behavior is controlled by explicit flags/permeability, not by colors or render order.
- Walls: `normal|reinforced|glass` share physical properties in MVP; render differently.
- A wall-hosted opening has `wallId`, center `offsetM` measured from wall start along centerline, `widthM`, sill and opening height, `state`. Renderer and grid compiler subtract the opening interval from solid wall geometry.
- Doors can be open/closed. An `exit` is a passable exterior portal in the MVP and must intersect a navigable building boundary. Closed windows are pedestrian barriers; air passability is reserved for a later solver.

### 3.1 Canonical document types

See `CONTRA_CONTRACTS.ts` in this handoff for compilable TypeScript declarations. Main shape:

```ts
interface BuildingDocument {
  schemaVersion: 1;
  projectId: ID;
  revision: number;
  floors: Floor[];
  vertices: Vertex[];
  entities: Entity[]; // discriminated union: wall/opening/furniture/fixture/zone
  hvacSystems: HVACSystem[];
  floorConnections: FloorConnection[];
}
```

No arbitrary blob JSON as a substitute for geometric types at the UI contract boundary. The DB may store compact JSON for entity-specific discriminated data to simplify its schema, but reducers must validate it.

### 3.2 Prefab contract

Assets are **data**, not per-object React components. Generic renderer looks up `prefabId`, SVG, footprint, and placement rules. Hard-code supported *kinds* and *generators* rather than arbitrary scripting:

- `rigid`: chair, table, desk, shelf, vending machine.
- `linear-stretch`: countertop; modify length along its local x-axis, preserve width and rendered endcaps.
- `wall-hosted`: doors, windows, exit symbols.

Assets should include dimensions, physical footprint, clearance rules, default material, SVG path, and optional stretch segment. When a valid asset is added to the registry it appears in the palette with **no per-asset code**.

### 3.3 Geometry validation and compilation

1. Validate floor boundary closed and non-self-intersecting; validate vertex references/positive sizes.
2. Resolve wall segments and opening intervals; disallow overlapping or out-of-bounds openings.
3. Generate transformed furniture footprints and exact collision polygons.
4. Compute walkable space inside boundary minus obstacles.
5. Rasterize fields at `cellSizeM=0.25`, keeping **fractional walkability** for partially covered cells.
6. Build a walkability mask and **navigation regions** connecting through open doors (no corner-cutting). Store explicit door/exit portals and capacities; vector collisions remain authoritative for movement.
7. Build **population-paint compartments** using the same geometry but treating even open door thresholds as dividers for painting purposes. A brush stroke touching both sides is split into two independently rasterized patches; do not blur through walls.
8. Build exit potential/navigation field from accessible exit portals, with shortest paths computed on the grid or a portal graph. Use exact doorway capacity to avoid misclassifying sub-cell openings.
9. Return validation diagnostics, compiled grid and field metadata keyed to `layoutHash`.

A room can be a derived connected compartment; users do not have to classify rooms to spawn people. A building with multiple disconnected interior regions is valid for editing, but unreachable occupants are reported during evacuation.

## 4. Occupancy painting and population initialization

### 4.1 Default behavior

- Population is specified as **count N**, not dependent on where users click.
- The initial distribution defaults to a uniform probability density over usable walkable area.
- Each cell gets a weight `w_i=1`; valid walkable area `A_i` accounts for partial cell occupancy.
- A paint stroke modifies weights within the radius of its polyline sample points; `w_i∈[0,4]` (0 means no intended initial spawn). Weight edits never alter `N`.
- Probability of choosing cell i: `p_i = w_i A_i / sum_j(w_j A_j)`; then sample an exact continuous position within its valid free portion, reject overlapping persons/obstacles. Seeded PRNG makes initialization repeatable.
- If people cannot fit with minimum separation, raise a clear `POPULATION_INFEASIBLE` diagnostic. Do not silently delete occupants.

### 4.2 Population brush

Inputs: floor ID, stroke polyline, radius meters, `set|increase|decrease|erase`, target weight or delta, optional falloff. Use world-space points, not pixels. Smooth within each physical compartment. `erase` restores weight 1, not 0. UI must display actual `N`, predicted spawnability, and a legend that the blue paint is **initial distribution**, not calculated congestion.

The brush may overlap two rooms at once. It updates the valid free-space cells in each room separately; wall cells are masked; its contributions should never be interpolated through barriers. Persist strokes inside the **scenario** and compile them against the frozen building revision. If walls move, recompile and show changes in initial distribution.

### 4.3 Goal selection

A painted patch has **no group AI**. Once spawned, pedestrians are individual actors; their **scenario goal** determines their paths. MVP goal is evacuation toward a reachable allowed exit. Each person can choose the lowest-cost reachable exit (cost = path distance plus dynamic queue penalty when implemented). This allows the same painted strokes to route differently on each side of a wall.

Optional future goals: selected exit, circulate within building, normal ingress/egress. No hard-coded room-use zones are necessary.

## 5. Simulation physics and outputs

### 5.1 Fixed 10 Hz engine

`dt = 0.1s` is fixed. Logical tick increments by exactly one per call. Server may simulate faster than wall-clock time for analysis, but all physics uses that fixed dt. The simulation worker must use a seedable PRNG, stable iteration order, and a frozen layout/scenario per run. Simulated time and rendering time are separate; drop visual frames under network pressure, never randomly skip physics ticks.

Per NPC: stable `id/index`, position, velocity, radius, preferred speed, current state, selected exit, waiting state. For each tick:

1. Get desired direction via navigation potential.
2. Find nearby people with spatial hash (coarser neighbor cell size than 0.25m allowed).
3. Compute low-cost repulsion/avoidance; clamp speed and acceleration.
4. Collision test against exact walls/furniture and other actors; prevent stepping through walls.
5. Enforce doorway/exit passage rate and queue if saturated.
6. Integrate position by dt; update exited count/throughput and field accumulators.

**No per-agent LLM.** Model is demonstrative, not certified evacuation physics. Spawn radius and clearance should be tuned and documented, not inferred from heatmap smoothing.

### 5.2 Two independent analysis layers

**Static geometry analysis (Design mode):** Computes walkable connectivity, exit distance, route convergence/passage demand based on assumed uniform origins. Runs on geometry change, without simulating people. Label it `potential bottleneck / route-demand estimate`, NOT observed congestion. Debounce and run in a browser worker (or shared simulation runner if easiest).

**Dynamic simulation (Live/Analysis):** Tracks actual NPC motion. Compute raw fields at 0.25m, and aggregate for rendering if necessary:

- `people.density` (people/m²)
- `people.averageSpeed` (m/s)
- `people.velocity` (m/s vector)
- `people.congestion` (heuristic: density × normalized speed reduction)
- `people.routeDemand` (static proxy)
- `people.exitDistance` (meters)

Report `current`, `timeAverage`, and `perCellPeak` for density/congestion. Mask solid barriers; avoid blurring adjacent rooms together. Exclude intentionally stationary visitors from treating all nonmovement as dangerous congestion.

Default completed heatmap = time-averaged dynamic congestion. The ending frame of an evacuation has nearly zero people, therefore is **not** the outcome heatmap.

### 5.3 Scenario types

**Evacuate (P0):** Initial population from uniform or painted distribution, immediate goal = exit, fixed geometry, finish when all reachable pedestrians have left or timeout; report trapped/unreachable separately. One or more exits can be disabled for adversarial tests.

**Circulate (P1):** A simple stochastic daily traffic model with no labeled room zones: initialize target occupancy; periodically choose reachable random destinations, dwell, exit, then new entrants spawn at designated exterior entries. A single global daily parabola controls desired occupancy; a **separate turnover rate** controls how much actual movement occurs. This is not real-world behavioral prediction. Default demo samples a short interval around a selected clock time, not a simulated 24 hours.

**Blocked Exit (P1):** Same evacuation inputs but one selected exit disabled. Nemotron can compare scenarios with identical initial actor positions/seeds.

### 5.4 Time-of-day usage curve

One optional global profile, no room zones:

`u(h) = clamp(1 - ((h - peakHour) / halfWidthHours)^2, 0, 1)`

`targetPeople(h) = round(minPeople + (maxPeople-minPeople)*u(h))`

For Evacuate, sample the selected hour once to establish `N`; then simulate evacuation seconds. For Circulate, a separate turnover/arrival-departure controller attempts to follow the profile, constrained by entrance throughput.

## 6. Server, frames, replay, and transport

### 6.1 Authoritative execution path

1. Browser submits `requestSimulation(projectId, scenario, expectedRevision)` through SpacetimeDB reducer.
2. Reducer verifies project membership, validates scenario, freezes geometry revision and scenario, creates `simulation_runs` status `queued`.
3. Node runner has a service identity; subscribes to worker-visible pending runs, claims a job using `claimSimulation` reducer, and loads its authorized frozen input.
4. Runner compiles geometry (cached by layout hash) and initializes NPCs deterministically. It advances ticks at 10 Hz for live mode, or runs uncoupled from real time for offline analysis.
5. Runner streams small binary actor state frames via a **dedicated WebSocket** to authorized viewers. Heatmap updates stream at 2 Hz, metrics at 1 Hz.
6. Browser receives, buffers, interpolates, and draws positions/fields at its frame rate. It does not re-run authoritative physics.
7. Runner saves final metrics, heatmap aggregates and bounded replay chunks through service-only SpacetimeDB reducers, changes run state to `complete`.
8. Analysis page loads saved results and replay chunks by authorized project access.

**SpacetimeDB does not execute 500 pedestrian position updates in 500 row transactions every 100ms.** SpacetimeDB is the majority of the application backend: permissions, saves, collaboration, run queues, data integrity, and history. The runner is a narrowly scoped compute/streaming service.

### 6.2 Authorization for frame WebSocket

Browser WebSocket sends an `AUTH` message (identity token + run ID) immediately after connection. The runner must **validate identity and access with SpacetimeDB** before streaming any private run; preferably by using the user's token in a caller-aware authorized view or verifying an OIDC JWT and membership via backend. Do not trust a projectId from the browser alone. Use WSS for public deployment. Worker service credential is stored only server-side.

### 6.3 Frame contract

State frames contain **data**, not rendered images:

- `runId`, `tick`, `simulatedSeconds`
- `actorXY: Float32Array` (stable `[x0,y0,x1,y1,...]` order), `actorFlags: Uint8Array` (e.g., moving/queued/exited), optional `actorFloorIndex: Uint8Array`.
- Actor identities are assigned once at run initialization; positions for exited actors may remain last known with a hidden flag.
- `FieldFrame` includes `fieldId`, `floorId`, grid metadata, values array, tick, and aggregation semantics.
- `MetricsFrame` includes current evacuated/remaining, per-exit throughput, queue statistics, and elapsed simulated seconds.

**Wire envelope:** version 1, message type, run ID, sequence, tick. Implement JSON control messages and binary frame payloads. Client drops stale/out-of-order frames. If packet loss or congestion occurs, old visual frames may be discarded; fixed simulation ticks never change.

### 6.4 Playback

Renderer retains previous and next frames and interpolates between actor XY values for smooth animation. Up to 60 FPS is a presentation target, not a physics rate. Pause does not change simulation state; playback speed controls visual consumption or runner pace separately.

**Replay storage:** write compressed **2-second chunks** (20 actor frames) and sparse heatmap frames. Keep chunk size bounded; do not insert individual frames as standalone rows. Prefer private `replay_chunks` rows with access through project-authorized views. For small demo scenes, store compressed chunks in SpacetimeDB; if tested row-size or bandwidth constraints prevent this, move only chunk bytes to object storage and retain authorized metadata in SpacetimeDB. Both implementations honor the same `ReplayStore` interface. Record format and model version must be saved. Avoid requiring perfect deterministic rerun as the only replay mechanism.

**Analysis defaults:** saved run results must remain viewable after browser refresh and original runner restart.

## 7. SpacetimeDB data model and reducers

SpacetimeDB TypeScript module is the **system of record**. All sensitive project tables private by default; caller-aware **views** expose only rows the caller is authorized to see. Public table visibility exposes all its rows, so do not put private projects in public tables and rely on frontend filtering. Reducers validate both roles and revision constraints; workers have allowlisted service identities/roles. Indexed views are important for scalability.

### 7.1 Tables

| Table | Fields / purpose |
|---|---|
| `users` | auth identity, display name (guest-safe) |
| `groups` | id, name, owner, timestamps |
| `group_members` | groupId, identity, role (`owner|editor|viewer`) |
| `group_invites` | groupId, hashed random secret, expiry/revoked |
| `projects` | id, groupId/owner, name, revision, updatedAt |
| `floors` | id, projectId, level, elevation, boundary |
| `vertices` | id, projectId, floorId, x, y |
| `entities` | id, projectId, floorId, kind, typed JSON payload, version |
| `hvac_systems` | optional duct graph and terminals |
| `scenarios` | id, projectId, typed scenario JSON, revision |
| `layout_snapshots` | immutable project revision/hash plus frozen document for runs |
| `simulation_runs` | id, layoutRevision/hash, scenario, modelVersion, seed, execution status |
| `simulation_results` | runId, metrics + aggregate heatmaps |
| `replay_chunks` | runId, startTick, endTick, encoding, bytes or object reference |
| `agent_jobs` | id, project, requester, status, budget |
| `agent_steps` | jobId, sequence, toolName, arguments/result summary |
| `proposals` | projectId, baseRevision, candidate edit commands, before/after metrics |

**Indexes:** by projectId on floors/vertices/entities/scenarios/runs; by groupId and identity on membership; by status on queues; by runId/startTick on replay chunks. Do not query the entire database on every editor update.

### 7.2 Reducers / app commands

- `createProject`, `renameProject`, `createGroup`, `inviteToGroup`, `joinGroup`, `setMemberRole`.
- `applyEdit(projectId, expectedRevision, requestId, command)`; variants: create/move vertex, create/update/delete wall, create/update/delete opening, place/transform/delete furniture, update type/material/parameters, create floor.
- `saveScenario`, `requestSimulation`, `cancelSimulation`, `requestAnalysis`.
- Worker-only: `claimSimulation`, `publishRunResult`, `appendReplayChunk`, `failSimulation`, `claimAgentJob`, `appendAgentStep`, `publishProposal`.
- `acceptProposal(projectId, proposalId, expectedRevision)` revalidates constraints and applies an atomic edit batch; the agent never writes directly to the live geometry.

Use generated TypeScript client bindings from the published SpacetimeDB module. The plain interface names in this spec are domain contracts, **not a claim about exact SDK-generated method names**.

### 7.3 Revisions and conflicts

Every accepted edit increments project revision atomically. `applyEdit` requires expected revision. For MVP, reject stale edits with `REVISION_CONFLICT`, refresh and retry; do not implement complex OT/CRDT. Wall chain operations may be an atomic batch. Runs always reference an immutable snapshot even while editing continues.

### 7.4 Guest saves and groups

Browser preserves its SpacetimeDB guest identity token across page visits (development only; token loss means loss of access). Do not treat a random client-provided user ID or plain cookie as authorization. For production use OIDC/SpacetimeAuth. Membership checked backend-side; invites use strong random secrets, server-side hashed lookup and expiration. No unauthenticated public-project subscriptions by default.

## 8. Nemotron agent: not a chatbot wrapper

NVIDIA requirement is a **multi-step tool-using workflow**. Show actions and tool results in a side panel, not just AI prose. Configure an available Nemotron model and hosted endpoint via environment (`NVIDIA_API_KEY`, `NEMOTRON_MODEL`), verify access before demo. Never expose key in browser.

### Tool capabilities (allowlisted, schema-validated)

- `inspect_layout(projectId, revision)` — retrieve shapes, exits, available area and geometry diagnostics.
- `inspect_run(runId)` — scenario and metrics.
- `get_hotspots(runId, metric, topK)` — ranked congestion regions and time windows.
- `run_scenario(projectId, revision, scenario)` — launch an analysis run.
- `test_edit_batch(projectId, revision, edits)` — clone candidate, validate geometry, rerun scenario.
- `compare_runs(baselineRunId, candidateRunId)` — compare matched seeds, population and mode.
- `submit_proposal(projectId, baseRevision, edits, evidence)` — persist candidate for human approval.
- Optional true external tool: lookup OpenStreetMap site footprint or documented environmental condition (not a decorative API call).

Nemotron should plan which scenarios to test, inspect tool results, decide follow-up experiments, then report with concrete measured metrics. Set a strict per-job budget (e.g. maximum 2 scenarios and 3 candidate edits for the live demo, maximum 12 tool invocations); timeouts and errors have meaningful UI states. For contested metrics, say **modeled change**, not improved actual building safety.

**Example:** Agent inspects a congested exit → tests disabling the exit → measures inaccessible occupants → tries relocating an interior doorway → validates that furniture does not intersect new geometry → reruns same seed → submits the measured improvement for approval.

## 9. HVAC, fire, and multi-floor reservation points

Do **not** implement full physics this weekend. Preserve the API so future features add models instead of rewriting the layout:

- `HVACSystem`: nodes, edges, terminals; an artist may draw ducts snapped to 0.25m grid; terminal `supply|return|exhaust`, direction, `flowM3PerSecond`, `zM`. Right-click vent to edit flow. A duct segment is a mechanical network edge, not a room-airflow vector.
- Future airflow model implements same simulation lifecycle but uses velocity, source/sink, directional face conductance arrays and balanced supply/return. Treat furniture height separately from wall permeability. A 2D airflow overlay is illustrative, not CFD certification.
- Future smoke model transports a concentration scalar using airflow/advection/diffusion, with realistic fire/thermal effects explicitly outside the MVP.
- `FloorConnection`: from/to floor ID, source/destination local positions, type (`stairs|ramp|elevator`), capacity persons/s, travel time seconds, travel direction. For MVP only floor 0 is active. Later stairs behave like constrained transition portals with queues, delay, and re-entry at linked location—not instantaneous exit from building.

The simulation API is model-agnostic: `initialize(frozenInput)`, `step(0.1)`, `snapshot()`, `fields()`, `metrics()`, `isComplete()`.

## 10. Shared TypeScript contracts and messages

Use `CONTRA_CONTRACTS.ts` as the initial **compilable source contract**. Team implementations can add refinements inside versioned types, but do not rename/remove fields within V1 without coordinated migration.

**Wire commands:** `START_RUN`, `PAUSE_RUN`, `RESUME_RUN`, `STOP_RUN`, `AUTH_STREAM`, `FRAME`, `FIELD`, `METRICS`, `RUN_COMPLETE`, `ERROR`. Version every message. Authoritative client/server state: `queued→running→complete|failed|cancelled`.

**Field names:** `people.density`, `people.speed`, `people.velocity`, `people.congestion`, `people.routeDemand`, `people.exitDistance` and reserved `air.velocity`, `air.flowMagnitude`, `smoke.concentration`.

**Run metadata:** immutable `layoutHash`, source revision, `scenarioId`, random seed, `modelVersion`, tickRate 10, grid size 0.25, actor count, execution kind, verification status. Comparison requires matched scenario and initialization policy.

## 11. Four-person team assignments

| Person | Primary ownership | Independent first deliverable |
|---|---|---|
| Artist/dev A | Next.js editor and UX, Konva, drawing, right-click, heatmap and frame renderer | Paintable static scene + mocked binary frames |
| Artist/game dev B | Venue scene, prefab SVGs, furniture, door/exits, content/palette + scenario demos | Venue and two smaller valid scene JSON fixtures with assets |
| Backend dev A | SpacetimeDB TypeScript schema, reducers, groups, guest saves, auth, snapshots/revisions | 2 clients save/edit same project; view only their group projects |
| Backend dev B | Geometry compiler, 10 Hz crowd engine, replay chunks, Node runner, Nemotron tools | Static field + seeded evacuation in deterministic tests; streamed frames |

All four jointly agree on types in `packages/contracts` immediately. No one designs a competing editor-data JSON format. Artists can author SVG and scene fixtures from day one, independent of whether the editor is finished.

### Integration check-ins (overlapping parallel work, not serial staffing)

| Hour | Required proof |
|---|---|
| 0–2 | Both sponsor SDK/API connections work; contracts compile; shared fixture loads; mock stream renders |
| 2–5 | One wall and door persisted via SpacetimeDB; venue visible; uniform population initializer produces valid positions |
| 5–9 | Painted distribution clips to walls; 10 Hz worker moves pedestrians toward exits; frames stream to browser |
| 9–13 | Dynamic heatmap + run metrics; two-client collaboration; completed replay chunks saved and reloadable |
| 13–18 | Nemotron tool loop analyzes hotspot and triggers actual simulation/tool run; proposal saved |
| 18–21 | One complete end-to-end demo; fixture cleanup; conditional traffic/duct extensions only if stable |
| 21–24 | Tests, hosted deployment, public GitHub repository, recorded backup demo, challenge submission |

## 12. Acceptance criteria and engineering tests

**Geometry:** straight and diagonal walls; shared endpoint moves neighbors; host door moves with wall; 0.9m door survives 0.25m sampling; glass/normal/reinforced render differently but block equally; table prevents pedestrian crossing; invalid footprint produces diagnostics.

**Population:** uniform initial density proportional to available area; painting radius and weight are world-scale; total N fixed; brush crossing a wall splits at barriers; no density smoothing through wall; reset restores uniform; identical seed gives identical initial coordinates; infeasible N returns explicit error.

**Physics:** no actors pass through walls/furniture; NPCs choose reachable exits independently of painted blob identity; narrow doorway queues form; disabled exit changes results; fixed 10 Hz steps; clear blocked/unreachable handling.

**Rendering/replay:** stream frame tick monotonic; rendering interpolation smooth; heatmap not erased when everybody exits; average/current/peak computed correctly; frame packet does not expose unauthorized group data; replay survives refresh; old run messages ignored.

**Persistence/security:** saved projects survive browser reload; group member sees authorized updates in two tabs; another guest cannot view/edit private project; optimistic revision conflict rejects stale writes; service-only result reducers reject ordinary clients.

**AI:** model invokes real tool(s), not hardcoded transcript; agent inspects measured congestion, executes a scenario or test candidate, returns a proposed valid edit; approval is required before live geometry changes; before/after displays source run and scenario details.

**Performance:** target 300–500 people with 10Hz updates; log actual compute time per tick, stream bytes/s, replay-chunk size. If runner cannot maintain live rate, label playback speed and allow faster/slower offline simulations; don't falsely imply realtime.

## 13. Demo sequence for judges (~2–3 minutes)

1. **Real venue:** open a visually recognizable approximation of the hackathon building. Demonstrate straight/diagonal vector walls and edits.
2. **SpacetimeDB proof:** two browsers show the same building. One user changes a door; the other updates instantly. Open project/group list to show save system.
3. **Population paint:** choose 300 occupants, paint a blue high-density region near a room entrance. Explain fixed total and geometry-clipped distribution.
4. **Simulation:** choose Evacuate, press Play. Backend worker runs discrete NPCs at 10Hz and streams state frames; browser draws and accumulates congestion heatmap.
5. **Results:** show time-averaged bottlenecks, replay scrubber, exit throughput, and model assumptions.
6. **Nemotron:** ask to investigate worst bottleneck. Show actual tool sequence, measured result and validated change proposal. If the full agent optimize loop isn't stable, use a real bounded two-step tool sequence rather than claiming autonomous iteration that didn't happen.
7. **Comparison:** accept candidate change and rerun on matched population scenario; show modeled before/after. Close with “a debugger for physical spaces.”

## 14. Known limitations to state explicitly

- Uniform/random population starts are **scenario assumptions**, not inferred actual occupancy.
- A single global daily usage parabola does not predict localized arrivals, and turnover is a separate input.
- Congestion is an internal heuristic from pedestrian density and speed; no claim of code compliance or fire evacuation certification.
- Server results are authoritative **within the model**, not ground truth about a real venue.
- Vector building dimensions and door placements should be verified before presenting them as factual. An approximate hackathon floor plan must be labeled approximate.
- Airflow/fire/vertical movement are future modules until demonstrably implemented.

## 15. Instructions to Claude Code and teammates

**Implement these contracts faithfully before inventing new ones.** Start from the provided `CONTRA_CONTRACTS.ts`, set up pnpm workspace and SpacetimeDB generated bindings, and use mock fixtures to let frontend and backend work concurrently. Prefer complete vertical slices over speculative generality. If a detail is missing, choose the simplest version consistent with V1 and record the decision. Maintain one clearly working demo path: **saved venue → painted starting population → server-driven evacuation → heatmap → replay → Nemotron tool analysis**.

**Do not** substitute an LLM-generated heatmap for computed results; serialize pixels instead of physical geometry; store every actor as a SpacetimeDB row every tick; make render order decide air/pedestrian collisions; or implement competing TypeScript model types in the frontend and backend.
