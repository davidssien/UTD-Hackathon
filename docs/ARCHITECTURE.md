# Egress — Architecture and contracts

Moved out of the master plan when it was rebuilt after `STABLE-V1` (D64). Sections keep their original numbers (§3–§8), so older references such as "Plan.md §8" point here. Priorities and decisions stay in [PLAN.md](../PLAN.md); the people-flow math is in [PEOPLE_FLOW_MODEL.md](PEOPLE_FLOW_MODEL.md).

## 3. Architecture

### Repo layout

```text
/                       npm workspace and backend build plan.
frontend/               Next.js app (frontend lane), moved here on main and merged back.
  app/ components/ lib/ public/ tests/
packages/
  core/                 @egress/core: domain types, Zod, applyEdit, wall graph, corner polygons,
                        rooms, diagnostics, canonical JSON + layoutHash, frame codec
  sim/                  @egress/sim: grid compiler, nav fields, population, step, fields, metrics
  client/               @egress/client: EgressClient interface, MockEgressClient,
                        SpacetimeEgressClient, React hooks, generated bindings
spacetimedb/            SpacetimeDB 2.x TypeScript module (the system of record)
services/runner/        Node 22 process: simulation worker + Nemotron agent
content/scenes/         Scene fixtures (EgressDocument v1 JSON)
content/prefabs.json    Furniture registry (later)
docs/                   Reference spec, partner sync notes
```

- npm workspaces: `frontend`, `packages/*`, `services/*`, `spacetimedb`. Root dev/build/start commands delegate to the frontend workspace.
- Tests use `node --test`, which strips types on Node ≥ 22.18. That only works with erasable TS syntax: no `enum`, no `namespace`, no parameter properties. Relative imports end in `.ts`, the same convention the partner's `lib/` already uses.

### Data flow

```text
Browser ──reducers──▶ SpacetimeDB ◀──reducers── Runner (Node, service identity)
   ▲   views per caller,                             │  claims runs + agent jobs
   │   scoped by the caller's sessions row           │  writes chunks / results / agent steps
   └──── entities · runs · replay_chunks · ◀─────────┘
         agent_steps · proposals                     └──▶ NVIDIA Nemotron (HTTPS)
```

- **There is no custom WebSocket.** Simulation frames reach the browser as `replay_chunks` rows through a subscribed view.
- **The runner only makes outbound connections,** so it can run on a laptop during the demo with nothing to host.
- **SpacetimeDB never runs per-pedestrian transactions.** One row per 2-second chunk.

---

## 4. Domain model — `@egress/core` (EgressDocument v1)

**Conventions:**
- Units are meters.
- Plan coordinates are `{x, y}`, with **+y = north**.
- Angles are radians, counter-clockwise.
- Snapping defaults to 0.25 m (the simulation cell size) and can be turned off.
- Adapters:
  - The 3D view maps plan `(x, y)` to three.js `(x, 0, -y)`.
  - SVG flips y.

```ts
type ID = string;
type Vec2 = { x: number; y: number };
type WallMaterial = 'normal' | 'reinforced' | 'glass';   // physically identical in the MVP; render differently

interface Floor   { kind: 'floor'; id: ID; level: number; name: string; elevationM: number; ceilingHeightM: number }
interface Vertex  { kind: 'vertex'; id: ID; floorId: ID; position: Vec2 }
interface Wall    { kind: 'wall'; id: ID; floorId: ID; startVertexId: ID; endVertexId: ID;
                    thicknessM: number; heightM: number; material: WallMaterial }
interface Opening { kind: 'opening'; id: ID; floorId: ID; wallId: ID;
                    openingKind: 'door' | 'window' | 'exit';
                    offsetM: number;                  // center, measured along the wall from its start vertex
                    widthM: number; sillHeightM: number; openingHeightM: number;
                    state: 'open' | 'closed' }
interface Slab    { kind: 'slab'; id: ID; floorId: ID; polygon: Vec2[];          // floor surface (D74), 3–128 points
                    material: 'wood' | 'basic' | 'tile' }
interface Stair   { kind: 'stair'; id: ID; floorId: ID; toFloorId: ID;           // straight stair to the floor directly above (D75)
                    min: Vec2; max: Vec2; upEdge: 'n' | 'e' | 's' | 'w' }        // upEdge = the side at the top
type Entity = Floor | Vertex | Wall | Opening | Slab | Stair;   // furniture joins later

interface EgressDocument {
  docVersion: 1;
  projectId: ID;
  revision: number;
  floors: Floor[]; vertices: Vertex[]; walls: Wall[]; openings: Opening[];
  slabs: Slab[]; stairs: Stair[];                     // default [] when parsing older documents
  furniture: [];                                      // reserved until the furniture pass
}
```

**Floors stack by `level`** (`floorsByLevel`, `groundFloorId`). A new floor sits on the top floor at its elevation plus its floor-to-floor height (`ceilingHeightM`); changing a height restacks every floor above; deleting a floor removes what is on it and every stair touching it, and lowers the floors above. A building always keeps one floor. A stair must be at least 0.8 × 0.8 m and connect a floor to the one directly above. Room hashes on upper floors are salted with the floor id, so stacked identical rooms keep separate labels; ground-floor hashes are unchanged.

**Invariants enforced by `applyEdit`.** The stored wall graph is always planar.
- A new wall endpoint within 1 mm (after snapping) of an existing vertex reuses that vertex.
- An endpoint that lands on another wall's interior splits that wall, creating a T-junction.
- Walls that cross are both split at a new vertex.
- When a wall is split, each opening moves to the piece that contains its center. The edit is rejected if an opening would straddle the split.
- Vertices left with no walls are deleted.
- These walls are rejected: zero-length, duplicate, collinear-overlapping, and shorter than 0.5 m. These rules port the partner's existing validation.
- An opening must fit inside its wall, at least 0.1 m from each end, and must not overlap another opening.
- An `exit` opening must sit on a wall bordering the exterior face. Otherwise it gets an `EXIT_ON_INTERIOR_WALL` diagnostic.

**Derived values** (computed, never stored):
- `wallPolygons(doc)`: one polygon per solid wall piece, with corners computed per junction:
  - **Degree 1:** flat cap.
  - **Degree 2:** miter, or a bevel if the angle is under about 30°.
  - **Degree ≥ 3:** each wall is mitered against its neighbours, plus a small hub polygon in the middle.
  - Opening intervals are subtracted from the wall.

  The same polygons feed the 3D structure (also viewed top-down during Edit) and simulation collision, so the picture always matches the physics. The plain `/dev` harness may draw them in SVG for backend testing; that is not a second product visual model.
- `rooms(doc)`: the bounded faces of the vertex graph, with openings treated as closed. This ports `lib/rooms.ts`.
- `exteriorBoundary(doc)`: the outer face.
- `diagnostics(doc)`: `NOT_ENCLOSED`, `NO_EXIT`, `EXIT_ON_INTERIOR_WALL`, `OPENING_OUTSIDE_WALL`, `OPENING_OVERLAP`, `UNREACHABLE_ROOM`. The editor saves invalid drafts; simulations report these diagnostics instead of crashing.
- `layoutHash(doc)`: a pure-JS SHA-256 of canonical JSON (sorted keys, `revision` excluded).

### Edit commands

```ts
type EditCommand =
  | { kind: 'createWallChain'; floorId: ID; points: Vec2[];          // pen tool; ≥2 points
      thicknessM: number; heightM: number; material: WallMaterial }
  | { kind: 'createBox'; floorId: ID; min: Vec2; max: Vec2;           // 4 vertices + 4 walls, shared corners
      thicknessM: number; heightM: number; material: WallMaterial }
  | { kind: 'eraseByLine'; floorId: ID; from: Vec2; to: Vec2 }        // deletes every wall piece the segment crosses, plus its openings
  | { kind: 'moveVertex'; vertexId: ID; to: Vec2 }
  | { kind: 'updateWall'; wallId: ID; patch: Partial<Pick<Wall, 'thicknessM' | 'heightM' | 'material'>> }
  | { kind: 'createOpening'; wallId: ID; openingKind: Opening['openingKind']; offsetM: number; widthM: number;
      sillHeightM?: number; openingHeightM?: number; state?: Opening['state'] }
  | { kind: 'updateOpening'; openingId: ID; patch: Partial<Pick<Opening, 'offsetM' | 'widthM' | 'state' | 'openingKind'>> }
  | { kind: 'deleteEntities'; ids: ID[] }
  | { kind: 'createSlab'; floorId: ID; polygon: Vec2[]; material: Slab['material'] }
  | { kind: 'updateSlab'; slabId: ID; patch: { material?; polygon? } }
  | { kind: 'createFloor'; name: string; ceilingHeightM?: number }     // on top of the highest floor
  | { kind: 'updateFloor'; floorId: ID; patch: { name?; ceilingHeightM? } } // restacks the floors above
  | { kind: 'createStair'; floorId: ID; min: Vec2; max: Vec2; upEdge: Stair['upEdge'] } // to the next floor up
  | { kind: 'updateStair'; stairId: ID; patch: { upEdge?; min?; max? } }
  | { kind: 'applyPatch'; put: Entity[]; remove: ID[] };              // undo/redo, imports, agent proposals

interface EditRequest { projectId: ID; requestId: ID; baseRevision: number; commands: EditCommand[] } // atomic batch

applyEdit(doc, request) →
  | { ok: true; doc; created: ID[][]; changed: ID[]; removed: ID[]; inverse: EditCommand }  // created[i] = IDs made by command i
  | { ok: false; error: DomainError }
```

- **`applyEdit` is pure and deterministic.** It never uses `crypto`, `Date` or `Math.random`.
- **Every new entity ID derives from the request:** `${requestId}.${n}`. That means:
  - The client's optimistic result and the server's authoritative result agree exactly.
  - A proposal applied with `requestId = proposal.id` gets the same IDs as its ghost preview.
- **`inverse`** is an `applyPatch`: it puts back the previous state of everything changed or removed, and removes everything created. Undo and redo are just more edits.

### Scenario

```ts
interface SimulationScenario {
  scenarioVersion: 1; id: ID; projectId: ID; name: string;
  population: { count: number; distribution: 'uniform' | 'painted';
                strokes: PopulationBrushStroke[];   // shape from the reference contracts; used from Pass 4
                seed: number };
  goal: { kind: 'evacuate'; blockedExitIds: ID[] }; // 'circulate' reserved (P1)
  durationSeconds: number;                          // timeout, default 300
}
```

`DomainErrorCode` uses the reference contract's list plus `NOT_IMPLEMENTED`, `STALE_EDIT` and `PROJECT_LOCKED` (an edit, accept or second run while the project's shared run is live, D89).

### Frame codec `egress-frames-v1`

One `replay_chunks.bytes` value is `gzip(fflate)` of:

```text
u32 magic 'EGF1' | u16 version = 1 | u16 reserved
u32 actorCount   | u32 firstTick   | u16 frameCount | u16 reserved
f32 originX      | f32 originY                         // meters; positions are relative to this
frame × frameCount:
  u16 xCm[actorCount] | u16 yCm[actorCount]            // centimeters from origin (≤ 655 m)
  u8  flags[actorCount], padded to 4 bytes             // 0 moving · 1 queued · 2 transitioning · 3 exited
```

- **Chunk size:** 20 frames, which is 2 simulated seconds.
- **Expected size:** about 50 KB raw and 20–35 KB gzipped at 500 actors.
- **Decoder output:** `{ tick, actorXY: Float32Array (meters), actorFlags: Uint8Array }[]`.
- **Actor indices** stay stable for the whole run.

**Heatmaps are not streamed.**
- The client computes Current, Average and Peak overlays from decoded frames, using the same `@egress/sim` field functions as the runner.
- The runner stores the authoritative final 0.25 m aggregates in `sim_results`.

**Field IDs:**

| Field | Meaning |
|---|---|
| `people.density` | people/m² |
| `people.speed` | m/s |
| `people.congestion` | density × max(0, 1 − speed / 1.34) |
| `people.exitDistance` | meters (static) |

Aggregations are `instant` (labelled "Current" in the UI), `timeAverage`, and `perCellPeak`. `people.velocity`, `people.routeDemand`, `air.*` and `smoke.*` are reserved.

---

## 5. Persistence — SpacetimeDB module

**Access rules:**
- Every table is **private**.
- Clients **read** only through views and **write** only through reducers.
- Each user's `sessions` row picks which project and run their views return, because views take no arguments.

| Table | Keys / indexes | Contents |
|---|---|---|
| `users` | pk identity | displayName, createdAt |
| `sessions` | pk identity | activeProjectId, activeRunId |
| `projects` | pk id | name, ownerIdentity, revision (u64), docVersion, updatedAt |
| `project_members` | idx projectId, idx identity | role: `owner` / `editor` / `viewer` |
| `project_invites` | pk codeHash | projectId, role, expiresAt, revoked |
| `entities` | pk id · idx projectId | kind, payload (JSON of the entity), rev |
| `edit_log` | pk autoinc · idx projectId | revision, requestId, author, commands JSON, at |
| `scenarios` | pk id · idx projectId | name, payload (scenario JSON) |
| `layout_snapshots` | pk hash | projectId, revision, document (EgressDocument JSON) |
| `sim_runs` | pk id · idx projectId · idx status | layoutHash, scenario JSON, seed, modelId, modelVersion, pace, status, progressTick, chunkCount, requestedBy, claimedBy, errorCode, timestamps |
| `sim_results` | pk runId | metrics JSON, fields (gzip Float32: average + peak, density + congestion), grid JSON |
| `replay_chunks` | pk autoinc · idx runId | chunkIndex, firstTick, lastTick, encoding, bytes (`t.array(t.u8())`) |
| `agent_jobs` | pk id · idx projectId · idx status | requestedBy, prompt, context JSON, status, budget JSON |
| `agent_steps` | pk autoinc · idx jobId | seq, kind (`thought` / `tool_call` / `tool_result` / `message` / `error`), toolName, payload JSON |
| `proposals` | pk id · idx projectId | jobId, baseRevision, commands JSON, notes JSON (command index → why), baselineRunId, candidateRunId, delta JSON, status |
| `online_connections` | pk identity | connection count while connected (presence) |
| `presence_modes` | pk identity | projectId, mode (`edit` / `simulate` / `analysis`), updatedAt; cleared on disconnect (D89) |

### Views

| View | Returns |
|---|---|
| `my_profile` | the caller's `users` row |
| `my_projects` | projects the caller belongs to, with their role |
| `active_project`, `active_members` | the project in `sessions.activeProjectId`, if the caller is a member |
| `active_entities`, `active_scenarios`, `active_edit_log` | that project's rows |
| `active_runs` | that project's runs |
| `active_replay`, `active_result` | chunks and result of `sessions.activeRunId`, if the caller is a member of its project |
| `active_agent_jobs`, `active_agent_steps`, `active_proposals` | the active project's agent data |
| `active_presence`, `active_presence_modes` | who of the active project's members is online with it open, and in which mode |
| `runner_queue`, `runner_inputs` | **runner identity only:** queued runs and agent jobs, plus the frozen inputs of runs it has claimed |

### Reducers

- **Lifecycle:**
  - `clientConnected` creates the `users` and `sessions` rows if they're missing.
  - `setDisplayName`.
- **Projects:**
  - `createProject(id, name, seedDocJson?)`.
  - `renameProject`.
  - `deleteProject` (owner only).
  - `createInvite(projectId, role, codeHash, expiresAt)` (owner only).
  - `revokeInvite`.
  - `joinProject(code)`, which hashes the code with core's SHA-256.
  - `setMemberRole` and `removeMember` (owner only).
- **Session:**
  - `openProject(projectId)`.
  - `openRun(runId)`.
  - `setMode(projectId, mode)`: presence by mode; `''` clears it.
- **Shared live simulation (D89):** a user run that is `queued` or `running` and has progressed in the last 2 minutes (`RUN_LOCK_STALE_MS`) locks its project. While it does, `applyEdit`, `acceptProposal` and a second `requestSimulation` fail with `PROJECT_LOCKED`. Agent runs never lock. The rule (`locksEditing`) lives in `@egress/core`, so both clients refuse locally with the same answer.
- **Editing:** `applyEdit(requestJson)`, editor role or higher:
  1. Load the project's entities into a document.
  2. Run `core.applyEdit`.
  3. Diff the result into rows.
  4. Increment the revision.
  5. Append to `edit_log`.

  An invalid command throws a `DomainError`.
- **Scenarios and runs:**
  - `saveScenario(json)`.
  - `requestSimulation(projectId, scenarioId, pace)`: builds the document, hashes it, inserts the `layout_snapshot` if it's new, and inserts a `sim_runs` row with status `queued`.
  - `cancelSimulation(runId)`.
- **Runner-only** (checked against the allowlist):
  - `claimSimulation`, `reportProgress`, `appendReplayChunk`, `publishRunResult`, `failSimulation`.
  - `claimAgentJob`, `appendAgentStep`, `publishProposal`, `finishAgentJob`.
  - `recordAgentRun`: candidate runs computed in-process.
- **Agent, called by users:**
  - `requestAgentJob(projectId, prompt, contextJson)`.
  - `acceptProposal(proposalId)`: editor role or higher. It re-runs `core.applyEdit` on the current document with `requestId = proposalId`, and returns `STALE_EDIT` if the edit no longer applies.
  - `rejectProposal`.

### Runner allowlist and secrets

- The runner registers its identity through `register_service(secret)`; the module stores the secret's SHA-256 and service identities (D21), not a hard-coded identity constant.
- Tokens live in gitignored `services/runner/.env.runner-token-<target hash>` files, scoped to URI and database. The legacy `.env.runner-token` is no longer read because a token issued locally is not valid on Maincloud (D45). The service secret and NVIDIA key remain server-side.

### Migration policy

- **Databases:** prod is `egress` on Maincloud and accepts **additive changes only**. Dev is `egress-dev` and may be wiped with `spacetime publish --delete-data`.
- **Payload versions:** JSON payloads carry `docVersion` / `scenarioVersion`, and upgrade functions live in `@egress/core`.

---

## 6. Simulation — `@egress/sim`

> **Source of truth for the math:** [docs/PEOPLE_FLOW_MODEL.md](PEOPLE_FLOW_MODEL.md) holds the exact formulas, parameter values, the reasons behind them, and validation results. This section is the original plan; where the two differ, the model doc wins.

The lifecycle is model-agnostic:

```text
compile(doc) → CompiledFloor
initialize(input, compiled) → SimState
step(state)                    // dt = 0.1 s, fixed
frame(state) · fields(state) · metrics(state) · isComplete(state)
```

**Compile** (cached by `layoutHash`):
1. Lay a 0.25 m grid over the exterior boundary's bounding box plus a 1 m margin.
2. Compute each cell's walkable fraction by 4×4 supersampling against `wallPolygons` (and furniture later). A cell is interior if it lies inside `rooms`.
3. Turn openings into portals:
   - Open doors and exits become passable line segments, with capacity **1.3 persons/m/s × widthM**.
   - Closed doors and windows count as walls.
4. Label regions: connected walkable cells (8-connected, no corner cutting) joined through open portals.
5. Build one distance field per exit: Dijkstra with octile distances over walkable cells.
   - Cells near walls get extra cost, about one actor radius, which keeps paths centred.
   - An infinite distance means unreachable.

**Initialize:**
- **Count:** N comes from the scenario.
- **Cell weight:** `w_i = 1` (painting comes in Pass 4) × walkable fraction.
- **Placement:**
  - Sample cells from the cumulative distribution using a seeded `sfc32` PRNG, and pick a uniform position within the chosen cell.
  - Reject the position if it's closer than one radius to a wall polygon, or closer than two radii to another actor.
  - After 50 failed attempts the run fails with `POPULATION_INFEASIBLE`. Actors are never silently dropped.
- **Actors:**
  - Radius is 0.22–0.25 m.
  - Preferred speed is drawn from N(1.34, 0.26), clamped to [0.8, 1.8] m/s.
  - Actors in regions with no reachable exit are counted as `unreachable` from tick 0.

**Step** (per actor, in stable index order):
1. **Exit choice,** every 20 ticks: pick the exit minimizing `distance / v_pref + queued(exit) / capacity(exit)`, with 10% hysteresis.
2. **Desired velocity:** −∇distance (steepest of the 8 neighbours, bilinear) × v_pref.
3. **Neighbours** come from a 1 m spatial hash.
   - Repulsion is `A·exp((r_ij − d)/B)·n̂`, with A = 2.0 and B = 0.3.
   - Velocity relaxes toward the desired velocity with τ = 0.5 s.
   - Speed is clamped to 1.5·v_pref and acceleration to 5 m/s².
4. **Collision:**
   - Circles collide against wall-polygon edges and are pushed out along the edge normal.
   - Overlapping actors are separated pairwise, in 2 iterations.
5. **Portals:**
   - Crossing a portal segment uses up a token from that portal's bucket, which refills at capacity × dt up to a maximum of 1.
   - An actor with no token available waits before the line, with the flag set to `queued`.
6. **Exit:** crossing an exit portal marks the actor `exited`. Its position freezes, it leaves the spatial hash, and that exit's throughput count goes up.

A run is **complete** when every reachable actor has exited, or when `durationSeconds` is reached.

**Fields:**
- **Density:** each actor is deposited into its cell, then smoothed 3×3 **within the same region only**, so nothing bleeds through walls.
- **Speed:** mean |v| per cell.
- **Congestion:** as defined in §4.
- **Accumulators:** `timeAverage` (sum ÷ ticks) and `perCellPeak`.

**Metrics** (shape from `SimulationMetrics` in the reference contracts):
- evacuation time
- evacuated, remaining and unreachable counts
- maxQueueLength
- mean and peak congestion
- perExitThroughput
- bottlenecks: the top 5 local maxima of time-averaged congestion, at least 1.5 m apart, each with its center and peak tick

**Determinism and performance:**
- Only the seeded PRNG is used for randomness, and iteration order is stable.
- Identical inputs must give an identical hash over all frames; a test checks this.
- Target: 500 actors in ≤ 10 ms per tick on a laptop.
- Log ms per tick and bytes per chunk.

---

## 7. Runner and agent — `services/runner`

**Run loop:**
1. Connect with the token saved for the selected URI/database, register the service identity, and subscribe to runner views.
2. Claim a queued run with `claimSimulation` (the first writer wins).
3. Read the frozen input from `runner_inputs`, then compile (LRU cache by `layoutHash`) and initialize.
4. Step. Every 20 ticks, encode a chunk, then call `appendReplayChunk` and `reportProgress`.
   - **User runs** are paced at 1×, 2× or 4× real time by sleeping against the wall clock, so the LIVE edge grows visibly.
   - **Agent runs** are unpaced.
5. Finish:
   - On completion, call `publishRunResult(metricsJson, fieldsBytes)`.
   - On error, call `failSimulation(code)`.
   - Check the run's status after every chunk, so cancellation takes effect within one chunk.

**Agent** (runs in the same process):
- **Model access:**
  - Endpoint: `https://integrate.api.nvidia.com/v1/chat/completions` (OpenAI-compatible).
  - Credentials and model come from `NVIDIA_API_KEY` and `NEMOTRON_MODEL`. The default model is `nvidia/nemotron-3-super-120b-a12b` and the fallback is `nvidia/nemotron-3.5-lightning-30b-a3b`.
  - Calls use plain `fetch` with OpenAI-style `tools`.
  - Hosted Lightning accepted tools and `chat_template_kwargs: { enable_thinking: false }` in live verification. The preferred Super model was unavailable; use `NEMOTRON_MODEL=nvidia/nemotron-3.5-lightning-30b-a3b` for the verified dev setup.
- **Tools.** Arguments are validated with Zod, and every call is logged to `agent_steps`.

| Tool | Does |
|---|---|
| `inspect_layout()` | document summary, rooms, exits, diagnostics |
| `inspect_run(runId)` | scenario and metrics |
| `get_hotspots(runId, topK)` | bottlenecks, with the nearest openings and walls |
| `run_scenario(scenarioPatch?)` | an unpaced run on the current layout |
| `test_edit_batch(commands)` | applies the commands to a copy with `core.applyEdit`, validates it, reruns with the **same seed and initial positions**, and returns metric deltas |
| `compare_runs(baselineRunId, candidateRunId)` | side-by-side metrics |
| `submit_proposal(commands, notes, evidence)` | saves a proposal for human approval; `notes` maps command index → why |

- **Budget per job:**
  - at most 12 tool calls
  - at most 2 scenarios
  - at most 3 candidate batches
  - 3 minutes of wall-clock time

  Timeouts and errors show up as visible steps.
- **No fabrication:** every number in the final message must come from a tool result. The agent never writes live geometry; only Accept does.
- **Proposal gate:** `submit_proposal` checks the candidate's original baseline and requires `ΔeffectiveTime + 0.1 × ΔmaxQueue < −0.5`, matching the existing heuristic ranking rule. Unchanged or worse candidates are rejected before persistence.

---

## 8. UI contract — modes, toolbars, `@egress/client`

### UI direction v2 (Cody, Sun 2026-11-08 00:00) — supersedes the Sat 19:10 notes, D47 (no modals) and D48 (local save slots)

Reference sketches: [layout-v2-rail-open.png](reference/gui/sketches/layout-v2-rail-open.png) and [layout-v2-rail-closed.png](reference/gui/sketches/layout-v2-rail-closed.png). Base the layout heavily on them.

**Principles**
- Egress is a CAD studio: professional, clean, cut. **No taglines**, eyebrows, slogans or explanatory sentences in the chrome. Labels are short nouns; help lives in tooltips with the shortcut.
- Buttons look and behave like CAD tool buttons: icon, tooltip, pressed state, keyboard shortcut.
- [Heroicons](https://heroicons.com) are placeholder icons until custom ones exist.
- Modals are allowed where they are the right tool: Projects (save/open), Share, Import.
- Don't surface room recognition or opening recognition in the UI (no "N rooms" counts).

**Layout**

| Region | Content |
|---|---|
| Canvas | The full-window 3D scene. |
| Top center | Compact mode switch: `Edit \| Simulate \| Analysis`. |
| Top left | Project name with sync state; the viewcube below it. |
| Top right | Presence: a person icon and the number of people on the project; hover lists their tokens. Layers dropdown beside it. |
| Left edge | **Pull tab.** Collapsed: a small tab with a chevron. Expanded: a vertical rail of meta actions (Projects, Share, Import, Export). |
| Right | **Context pane**, only when the mode or selection has something to show. Its bottom box holds the primary action. |
| Bottom center | **Context toolbar**, a tab attached to the bottom edge. It switches with the mode. |

**Modes**

| Mode | Bottom toolbar | Right pane |
|---|---|---|
| **Edit** | Select · **Wall** (right-click the button for a small type menu: Normal / Reinforced / Glass) · Room · Door · Window · Exit · Erase · Undo · Redo. Right-clicking a wall in the canvas opens the same type menu plus Delete. | Inspector, only while something is selected. |
| **Simulate** | Run/Stop at the left; **transport and timeline centered**: `« 10` · `⏯` · `» 10`, scrubber from 0 to the LIVE edge, `LIVE` / `END` badge, speed 1× / 2× / 4×. | Population: count, distribution, seed (painting later), then live metrics. Run in the bottom box. |
| **Analysis** | **A chat bar** (prompt + send). | Grows live as the agent works: steps, measured results, proposals with Accept / Reject, before/after. It replaces the separate Report / Suggestions tabs. |

**Analysis suggestions on the model**
- Suggested edits are **highlighted in blue on the model itself**: created and changed walls/openings glow blue; removed ones are hatched red.
- A proposal can hold **several edits**. A small bubble sits next to each edit with a one-line reason (`proposal.notes.byCommand[i]`).
- The agent bases its changes on both **compliance** (code-style checks) and **measured safety** (simulation). See backend follow-ups.

**Layers** (dropdown, select one)
- **People** (now). Options: **Discrete** (people as dots) or **Heatmap**. Heatmap field: Density or Congestion. Statistic: Current / Average / Peak. After a run completes, Average is the default, because the final frame is an empty building.
- **Airflow** (future): listed but disabled. Its fields (`air.velocity`, `air.flowMagnitude`, `smoke.concentration`) are reserved in `FieldIdSchema`.

**Scene**
- **One 3D scene; Edit is always top-down.** Edit locks the scene to an orthographic overhead camera. Leaving Edit transitions to isometric and enables orbit. There is no second 2D model.
- **Viewcube works like a CAD viewcube** (D63): drag it to orbit the camera; click a face, edge or corner to snap to that view; it always mirrors the camera. Edit stays top-down, so in Edit the cube only offers Top.
- **Blueprint look:** a blue floor and a **white dot grid**: 0.25 m snap dots, brighter every metre. **No grid lines.** Drawing previews are white.
- **Occluding walls are cross-hatched, never dithered.** Top-down views never fade anything. Outside top-down, walls between the camera and the interior floor draw as evenly spaced screen-space cross-hatching. This matches the hand-drawn look planned for future models. Furniture stays opaque.
- **Parametric vs placeable.** Only walls are parametric now; counters and similar runs are planned. Everything else is a placeable: **wall-attached** (doors, windows, exits) or **floor-placed** (furniture). Floor-placed items rotate about the vertical axis only (yaw); wall-attached items follow their wall (D88).
- **Blender wall textures.** `frontend/public/assets/walls/manifest.json` maps each wall material, and later each `finish` id, to textures exported from Blender (base colour, optional normal and roughness). UVs are world-scale, so a texture repeats every `repeatM` metres on any wall length. A missing file falls back to the flat material colour. Physics never reads textures or `finish`.

**Simulate rules** (unchanged from D36)
- Only the **distribution** and **elements** (future: fire, via `scenario.elements`) change in Simulate. Building edits happen in Edit.
- Either change needs a restart. Stop calls `cancelRun`.
- Pause and scrub are client-side. The server keeps simulating while paused. Stop or restart cancels the server job within ~100 ms.
- Population paint is labelled *initial distribution*, never congestion.

**Storage, identity and collaboration**
- **Project storage is never browser-local.** Projects live in SpacetimeDB: Maincloud `egress-dev` for the demo, or `?backend=local` for a local dev server. Browser storage holds only the SpacetimeDB token, the "cookie" that links this browser to its projects. The local save slots are removed.
- **One permanent share link per project.** It works whether or not the owner is online, and joining through it always gives **viewer** access.
- **Owners** can raise anyone to editor or owner. Every owner token sees the project in its Projects list; projects shared with you appear separately.
- People are recognized by token for now.
- Until the backend follow-up lands, Share issues a 14-day viewer invite through the existing `createInvite`.

**Backend follow-ups** (next backend pass)
1. Collaboration: a permanent `project_links` code, `join_by_link`, presence (an online-connections table plus an `active_presence` view), and `members`, `presence`, `shareLink()` and `setMemberRole()` on `EgressClient`.
2. Compliance checks as an agent tool. Each is a modeled check, not a certification: door, exit and corridor minimum widths; exit count against occupant load; travel distance.
3. Multi-edit proposals: combine non-conflicting winning candidates into one batch, re-test the batch, and give each command its own reason.

### `@egress/client` (sketch, finalized in Pass 0)

```ts
interface Store<T> { get(): T; subscribe(fn: () => void): () => void }   // for useSyncExternalStore

interface EgressClient {
  me: Store<{ identity: string; displayName: string } | null>;
  projects: Store<ProjectSummary[]>;
  createProject(name: string, seed?: EgressDocument): Promise<ID>;
  openProject(id: ID): Promise<void>;
  createInvite(role: Role): Promise<string>;          // returns the plain code; only its hash is stored
  joinProject(code: string): Promise<ID>;

  document: Store<DocumentView>;                      // server doc + optimistic edits + derived polygons/rooms/diagnostics
  edit(commands: EditCommand[]): Promise<EditResult>;
  undo(): void; redo(): void;

  runs: Store<RunSummary[]>;
  startRun(scenario: SimulationScenario, pace: Pace): Promise<ID>;
  playback(runId: ID): PlaybackController;

  agent: {
    ask(prompt: string, context?: AgentContext): Promise<ID>;
    steps: Store<AgentStep[]>;
    proposals: Store<ProposalView[]>;                 // includes ghost diff: added / removed / changed entities
    accept(id: ID): Promise<void>;
    reject(id: ID): Promise<void>;
  };
}

interface PlaybackController {
  state: Store<{ tick: number; liveTick: number; playing: boolean; complete: boolean; speed: number }>;
  play(): void; pause(): void; seek(tick: number): void; skip(seconds: number): void; goLive(): void;
  actorsAt(timeSeconds: number): { xy: Float32Array; flags: Uint8Array };   // interpolated
  field(id: FieldId, agg: Aggregation): ScalarField | null;
  metrics: Store<SimulationMetrics | null>;
}
```

- **Two implementations share this interface:**
  - `MockEgressClient`: in-memory, with a canned run.
  - `SpacetimeEgressClient`: the real backend.
- **React access** goes through `useEgress(store)`.

