# Egress — Build Plan

> The plan for the 24-hour build, kept up to date as decisions change. It's maintained by the backend lane (Cody + Claude). Whenever a decision changes, update the **Decision log** (§14).
>
> Source material:
> - [docs/reference/CONTRA_FINAL_SPEC.md](docs/reference/CONTRA_FINAL_SPEC.md): the original spec. The product has since been renamed Contra → Egress.
> - [docs/reference/CONTRA_CONTRACTS.ts](docs/reference/CONTRA_CONTRACTS.ts): reference only. Where they differ, this plan wins.
>
> Partner discussion items are in [docs/PARTNER_SYNC.md](docs/PARTNER_SYNC.md).

**Deadline:** Sun 2026-11-08 12:00 CST · **Written:** Sat 2026-11-07 17:10 CST · **Branch:** `implement-backend`

## Status — Sat 19:00 CST

**Working now, on `main`:** open `/dev` (`npm run dev`, then http://localhost:3000/dev). Everything below runs in the browser through the mock client.
- **Edit:** pen, box, erase and door/exit/window tools on a planar wall graph, with T-junction splitting and boxes that share sides.
  - Walls draw as polygons with computed corners.
  - Rooms, diagnostics and the route-demand "potential bottleneck" estimate update as you edit.
- **Live:** the real pedestrian model, egress-pedestrian v0.1, at 10 Hz.
  - Paced runs with `« 10` / `⏯` / `» 10` controls and a scrubber up to the LIVE edge (END once the run finishes).
  - Current, Average and Peak heatmaps; the Average heatmap persists after everyone has left.
  - Population painting.
  - Benchmark: 500 people clear the hall in about 142 s simulated, at about 1.5 ms per tick.
- **Analysis:** the real agent tools run real simulations on the same people.
  - Example: on the two-rooms fixture it measured "widen the exit to 1.8 m: −40 s (−35%)" and proposed it.
  - Proposals show as a ghost with a "why" bubble; Accept applies exactly the ghosted edit.
- **Agent CLI:** `npm run agent:local -w @egress/runner -- hall.json 300` runs the agent from the command line. It uses Nemotron when `NVIDIA_API_KEY` is set, otherwise the measured heuristic planner.

**SpacetimeDB, verified locally (Sat 19:00):**
- **Install:** CLI 2.14.1 is installed at `%LOCALAPPDATA%\SpacetimeDB`.
- **Module:** published to a local server, with bindings generated into `packages/client/src/bindings` using `.ts` imports.
- **Runner:** `services/runner/src/main.ts` connects, registers with the shared secret, and claims runs and agent jobs.
- **End-to-end check:** `npm run e2e:local -w @egress/runner` passed every step:
  - project creation
  - session-scoped views re-evaluating on project switch
  - `apply_edit`
  - a runner-claimed simulation with gzip chunks arriving as `Uint8Array`, plus field results
  - agent job → measured proposal → `accept_proposal`
- **Local server workflow:**
  1. `spacetimedb-cli start --listen-addr 127.0.0.1:3010`
  2. `npm run publish:local -w @egress/spacetimedb`
  3. `npm run generate -w @egress/spacetimedb`

**Still open:**
1. **Cody:** run `spacetime login`, then `npm run publish:dev -w @egress/spacetimedb` to deploy to Maincloud.
2. **Backend:** `SpacetimeEgressClient`, the browser implementation of `EgressClient`, built from the bindings plus `OptimisticDocument` and `Playback`.
3. **Cody:** put `NVIDIA_API_KEY` in `services/runner/.env` to switch the agent from the heuristic planner to Nemotron.

**Pitch:** Egress is a collaborative building editor. You draw a floor plan, drop in a crowd, run a pedestrian-flow evacuation, watch congestion build up, and scrub the replay. A Nemotron agent then tests design changes against measured results.

---

## 1. Ground rules

- **Every pass ends in a working build.** If time runs out mid-pass, ship the previous pass plus whatever of the current one is green.
- **Two lanes:**
  - Backend: Cody + Claude, on `implement-backend`.
  - Frontend: davidssien, building the ExitCraft UI on `main`.
- **One boundary:** the frontend talks to the backend only through `@egress/client`. No UI component imports SpacetimeDB bindings directly.
- **One data model:** `@egress/core` defines it. No second copy of domain types anywhere.
- **Numbers come from the simulation only.** Every metric comes from `@egress/sim`, and the agent never invents numbers.
- **Honest claims:** this is an exploratory flow model, not fire-code certification. Say "modeled change", never "safer building".
- **Next.js 16 differs from training data.** Before writing Next code, read the relevant guide in `node_modules/next/dist/docs/` (see AGENTS.md).
- **Prefer complete vertical slices** over speculative generality. If a detail is missing, pick the simplest option consistent with this plan and log it in §14.

## 2. Timeline

| Pass | Window (CST) | Ends with |
|---|---|---|
| **0 Stable base** | Sat 17:00–19:30 | Contracts and schema frozen. Everything compiles, the partner can use the mock client, and Pass 0 is merged into `main`. |
| **1 Saved editing** | 19:30–22:30 | Two browsers co-edit a saved project. |
| **2 Congestion core** | 22:30–Sun 03:30 | **Functional base.** An Evacuate run streams into Live mode with a heatmap, and its replay survives a refresh. |
| **3 Analysis agent** | 03:30–07:00 | Nemotron calls real tools and proposes a measured edit; Accept applies it. |
| **4 Merge & harden** | 07:00–10:00 | Partner UI merged, venue scene, population painting, deployed. |
| **5 Submit** | 10:00–12:00 | Code freeze at 10:30, backup video, README, submission. |

**Cut order if behind:**
1. Pass 4 extras: the static heatmap, then painting, then venue polish.
2. Analysis polish.
3. Pass 2 is never cut.

---

## 3. Architecture

### Repo layout

```text
/                       Next.js app (frontend lane). Stays at the root and uses npm.
  app/ components/ lib/ public/ tests/
  app/dev/              Plain backend test page at /dev (backend lane). The partner's UI replaces it at merge.
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

- npm workspaces: `packages/*`, `services/*`, `spacetimedb`.
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
type Entity = Floor | Vertex | Wall | Opening;        // furniture joins later

interface EgressDocument {
  docVersion: 1;
  projectId: ID;
  revision: number;
  floors: Floor[]; vertices: Vertex[]; walls: Wall[]; openings: Opening[];
  furniture: [];                                      // reserved until the furniture pass
}
```

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

  The same polygons feed the 2D plan, the 3D extrusion, and simulation collision, so the picture always matches the physics.
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

`DomainErrorCode` uses the reference contract's list plus `NOT_IMPLEMENTED` and `STALE_EDIT`.

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

- The runner's **identity** (public hex, safe to commit) is a constant in the module.
- Its **token** lives only in `services/runner/.env`, which `.env*` already gitignores.

### Migration policy

- **Databases:** prod is `egress` on Maincloud and accepts **additive changes only**. Dev is `egress-dev` and may be wiped with `spacetime publish --delete-data`.
- **Payload versions:** JSON payloads carry `docVersion` / `scenarioVersion`, and upgrade functions live in `@egress/core`.

---

## 6. Simulation — `@egress/sim`

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
1. Connect with the stored token (`RUNNER_TOKEN`) and subscribe to `runner_queue`.
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
  - Sending `chat_template_kwargs: { enable_thinking: false }` would cut latency, but the hosted API hasn't been tested with it yet. That's a Pass 0 spike.
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

---

## 8. UI contract — modes, toolbars, `@egress/client`

### UI direction (Cody, Sat 19:10) — for the frontend lane

- **Edit is always top-down.** Every layout edit happens in an orthographic plan view, with no orbit or tilt while editing. Free-look 3D is for viewing the result after editing, and it is never an editing surface.
- **Blueprint look:** the floor is blueprint blue. Walls, and anything added from now on (openings, furniture, guides), are drawn in white lines.
- **Dot grid, thin walls.**
  - The plan shows a grid of dots: every grid intersection is a dot, and walls are built along the grid lines between dots.
  - Walls render with a small thickness.
  - No contract change: dots are the 0.25 m snap points, and a wall's endpoints become `Vertex` entities when you click them.
- **Custom wall textures are coming.**
  - Walls carry an optional per-side `finish: { left?, right? }` holding texture IDs from a future finishes registry, where left and right are relative to start→end.
  - Physics never reads `finish`; it uses `material` and geometry only.
  - The 3D view should texture each side of the extruded `wallPolygons` piece from it, falling back to the material colour.

Mode tabs sit at the top, and the toolbar switches with the mode.

| Mode | Toolbar |
|---|---|
| **Edit** | **Pen:** click-to-click wall chain; Esc ends it; snaps to 0.25 m and to existing vertices.<br>**Box:** drag to make 4 walls.<br>**Erase:** drag a line; every wall it crosses is deleted.<br>**Door / Exit / Window:** click a wall.<br>**Undo / Redo** |
| **Live** | **Run setup:** population N, seed, pace.<br>**Transport:** `« 10` · `⏯` · `» 10`, jumping 10 **simulated seconds**.<br>**Bottom scrubber:** runs from 0 to the **LIVE** edge, the latest tick received. A `LIVE` badge jumps back to the edge, and turns into `END` once the run completes.<br>**Heatmap selector:** Current / Average / Peak.<br>**Metrics panel** |
| **Analysis** | **A chat box replaces the toolbar.**<br>**Tool-step cards:** one per agent action.<br>**Ghost entities:** suggested edits render immediately, tinted and dashed, each with a "why" bubble.<br>**Accept / Reject** per proposal.<br>**Before/after metrics card** |

- **Default heatmap:** after a run completes, the heatmap shows time-averaged congestion. The final instantaneous density is empty and misleading.
- **Paint wording:** population paint is labelled *initial distribution*, never congestion.

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

---

## 9. Passes

Each pass lists backend chunks, `/dev` work, what the partner can start on, and its done-when. Every chunk is written so a teammate or a separate Claude session can pick it up cold.

### Pass 0 — Stable base (17:00–19:30)

**Goal:** nothing works end-to-end yet, but every boundary exists, compiles, and is frozen, so both lanes can build in parallel.

- [x] **0.1 Workspaces:**
  - Root `package.json` gets `workspaces`.
  - `tsconfig.base.json`: strict, `erasableSyntaxOnly`, `allowImportingTsExtensions`, `noEmit`.
  - Package skeletons with `exports` → `src/index.ts`.
  - Root `npm test` runs every workspace's `node --test`.
  - Next `transpilePackages` for `@egress/*`; check `node_modules/next/dist/docs/` first.
  - Partner files untouched apart from `package.json` and `next.config.ts`.
- [ ] **0.2 SpacetimeDB setup:**
  - Install the `spacetime` CLI (`iwr https://windows.spacetimedb.com -useb | iex`).
  - *Human:* `spacetime login`.
  - Scaffold the TS module in `spacetimedb/`.
- [x] **0.3 `@egress/core`:**
  - All §4 types plus Zod mirrors, and `DomainError`.
  - Canonical JSON and `layoutHash`.
  - The frame codec, with round-trip tests.
  - `applyEdit` with `createWallChain`, `createBox` and `deleteEntities` working. Everything else returns `NOT_IMPLEMENTED`.
- [x] **0.4 Fixtures:**
  - `content/scenes/one-room.json`: a 10 × 8 m room with one 0.9 m exit.
  - `content/scenes/two-rooms-corridor.json`: two rooms feeding a 1.2 m corridor to one exit, a deliberate bottleneck.
  - A test checks both parse and pass diagnostics.
- [ ] **0.5 Module:** (code written and typechecked; publish + codegen wait on the CLI)
  - All §5 tables, `sessions`, and the views.
  - Reducers stubbed, with their auth checks.
  - Publish `egress-dev` to Maincloud.
  - Generate bindings into `packages/client/src/bindings`.
- [ ] **0.6 Spike** (≤ 30 min; record the outcome in §14):
  - (a) Does a view re-evaluate when the caller's `sessions` row changes?
  - (b) Does the module bundle workspace `@egress/core` and Zod?
  - (c) Does `t.array(t.u8())` arrive as `Uint8Array` or `number[]`?
  - (d) Does hosted Nemotron accept `tools` and `chat_template_kwargs`?

  Fallbacks:
  - If (a) fails, use authorized procedures such as `getReplayChunks(runId, fromIndex)`.
  - If (b) fails, keep the module's validation self-contained.
- [ ] **0.7 Runner skeleton:** (config, Nemotron client and spike script done; connection waits on bindings)
  - Create and store a token, connect, and print the identity.
  - Add the identity constant to the module allowlist.
  - Subscribe to `runner_queue`.
- [x] **0.8 `@egress/client`:**
  - The interface.
  - `MockEgressClient`: uses `core.applyEdit` and plays a canned 20-second run of actors walking to the exit.
  - The React hooks.
- [x] **0.9 `/dev` shell:** (Edit tools work against the mock)
  - Mode tabs.
  - Toolbar placeholders per mode.
  - A 2D canvas rendering a fixture through the mock.

**Partner can start:** rendering `DocumentView`, the mode tabs and toolbars, and the Live time bar against the mock's canned run.

**Done when:**
- `npm test`, the typecheck and `npm run build` are green.
- `egress-dev` is published.
- The runner connects.
- `/dev` renders a fixture.
- Pass 0 is merged into `main` (additive only).

### Pass 1 — Saved editing (19:30–22:30)

- [x] **1.1 Graph operations in `applyEdit`:**
  - Snapping and vertex merging.
  - T-junction and crossing splits, moving each opening onto the right piece.
  - Orphan cleanup.
  - Commands: `eraseByLine`, `moveVertex`, `updateWall`, `createOpening`, `updateOpening`, `applyPatch`.
  - `inverse` generation.
  - Port the partner's validation rules.
- [x] **1.2 `wallPolygons`:**
  - Corners and opening subtraction.
  - Tests: an L-corner has no notch; T and X junctions; 45°; a 15° bevel; a door cut.
- [x] **1.3 Derived values and tests:** `rooms`, `exteriorBoundary`, `diagnostics`, with tests adapted from `tests/rooms.test.ts`.
- [ ] **1.4 Module reducers:**
  - `applyEdit`: load → apply → diff → write → revision++ → `edit_log`.
  - Projects, invites and roles.
  - `openProject`.
  - A viewer can't edit, and a non-member sees nothing.
- [ ] **1.5 `SpacetimeEgressClient`:**
  - The token is kept in `localStorage`.
  - View subscriptions build the `DocumentView`.
  - An optimistic queue of pending edits, reconciled by `requestId` against `edit_log`.
  - Undo and redo through inverse patches.
- [x] **1.6 `/dev` Edit mode:** — *(against the mock client)*
  - Pen, box, erase-by-line, and door/exit placement.
  - Project list, create, invite code, join.

**Done when:**
- Two browsers on one project see each other's edits in under 1 s.
- A reload keeps everything.
- A third guest can't see the project.
- A stale edit is rejected cleanly.
- Tests are green.

**Cut if late:** the `moveVertex` drag UI and windows.

### Pass 2 — Congestion core (22:30–03:30) · FUNCTIONAL BASE

- [x] **2.1 `sim/compile`:** grid, walkable fraction, interior, portals and regions, cached by `layoutHash`.
- [x] **2.2 `sim/nav`:** distance fields and unreachable detection.
- [x] **2.3 `sim/population`:** uniform seeded sampling and `POPULATION_INFEASIBLE`.
- [x] **2.4 `sim/step`:** per §6.
- [x] **2.5 `sim/fields` and `sim/metrics`.**
- [x] **2.6 Tests:**
  - No actor is ever inside a wall polygon (fuzzed over seeds).
  - A 0.9 m door is passable on the 0.25 m grid.
  - A queue forms in the corridor fixture.
  - The same seed gives an identical frame hash.
  - Blocking an exit changes the metrics.
  - A run completes.
  - An infeasible N errors.
- [ ] **2.7 Module:**
  - `saveScenario`.
  - `requestSimulation`: freezes and dedupes the snapshot.
  - `cancelSimulation`.
  - The runner reducers.
  - Run, replay and result views.
  - `openRun`.
- [ ] **2.8 Runner run loop:** per §7, with pacing and performance logs.
- [x] **2.9 Client:** — *(Playback, LIVE edge, heatmaps from frames; the mock runs the real sim in the browser)*
  - `startRun`.
  - `PlaybackController`: buffers chunks, interpolates, tracks the LIVE edge, handles ±10 s skips and seeking.
  - Fields computed client-side from frames, with final aggregates from `sim_results`.
- [x] **2.10 `/dev` Live mode:** toolbar, time bar, heatmap, metrics.

**Done when:**
- 300 people evacuate the corridor fixture with a visible queue.
- The heatmap stays after completion, with time-average as the default.
- Refreshing still replays the run.
- The LIVE edge grows during a paced run.
- 500 actors take ≤ 10 ms per tick.

**Cut if late:** the speed field, the bottleneck list, and pace options (keep 1×).

### Pass 3 — Analysis agent (03:30–07:00)

- [x] **3.1 Agent loop:** the Nemotron client, the tool loop, the budget, step logging.
- [x] **3.2 Tools:** per §7. Candidate runs execute unpaced in-process and are recorded with `recordAgentRun`, so they appear as ordinary runs.
- [ ] **3.3 Module:**
  - Agent reducers and views.
  - `acceptProposal` through `core.applyEdit` with `requestId = proposalId`.
- [x] **3.4 Client:** — *(the mock runs the real agent tools and heuristic planner in the browser)*
  - `agent.ask`, `steps`, `proposals`, `accept`, `reject`.
  - The ghost diff: the proposal patch applied to a copy of the document, then diffed against the current one.
- [x] **3.5 `/dev` Analysis mode:**
  - Chat and step cards.
  - Ghost entities with bubbles.
  - Accept / Reject.
  - The before/after card.

**Done when:**
1. Asking "Investigate the worst bottleneck" produces real tool calls.
2. A candidate runs on the same seed.
3. The proposal shows a measured delta.
4. Accept updates both browsers.

**Fallback:** if free-form tool use is unreliable, run a fixed but real two-step sequence: `get_hotspots`, then `test_edit_batch` on the top suggestion. The model only writes the explanation. **Never a canned transcript.**

### Pass 4 — Merge and harden (07:00–10:00)

- [ ] **4.1 Full merge with the partner UI:** wire their components to `@egress/client`, and drop `/dev` from navigation (keep the route).
- [ ] **4.2 Venue scene:** `content/scenes/venue.json`, drawn in the editor and labelled approximate. Image detection only if time allows.
- [x] **4.3 Population painting:**
  - Scenario strokes.
  - Compartments split at walls and door thresholds.
  - Erase restores weight 1.
  - Total N never changes.
- [x] **4.4 Edit-mode static heatmap:** exit distance and route demand from `sim/nav`, labelled "potential bottleneck estimate".
- [ ] **4.5 Deploy:**
  - Web host (likely Vercel; confirm with the partner).
  - Maincloud prod database `egress`.
  - Runner on the demo laptop.
  - Environment variables.
- [ ] **4.6 Finish:** error and empty states, plus visible performance logs.

**Cut order:**
1. 4.4
2. 4.3
3. 4.2 polish

### Pass 5 — Submit (10:00–12:00)

- [ ] **10:30 code freeze** (fixes only).
- [ ] **Backup demo video** following the demo script in spec §13.
- [ ] **README:** setup, architecture, and the limitations from spec §14.
- [ ] **Public repo** and the submission form.

---

## 10. Branch and merge workflow

- **Daily rhythm:** work on `implement-backend`. After every partner commit to `main`:
  1. `git merge origin/main` into our branch.
  2. Run the tests and `/dev` against the new UI.
  3. Resolve any conflicts here, not on `main`.
- **Pass 0 lands on `main` early.** It's additive: new folders plus the workspace config. The partner pulls it and builds against the contracts and the mock.
- **Full merge into `main` after Pass 2,** once [docs/PARTNER_SYNC.md](docs/PARTNER_SYNC.md) is settled.
- **Partner files stay untouched on our branch,** with these exceptions: `package.json` (workspaces), `next.config.ts` (transpilePackages), and `lib/` re-export shims once agreed.

## 11. Testing

- **Runner:** `node --test` in every workspace, with fixtures in `content/scenes/`.
- **Acceptance tests** mirror spec §12: geometry, population, physics, rendering/replay, persistence/security, and AI. Each pass lists its own.
- **Determinism tests** compare a SHA-256 over all frames of a run.

## 12. Risks and spikes

| Risk | Mitigation |
|---|---|
| Views don't re-evaluate when `sessions` changes | Pass 0 spike; fall back to authorized procedures |
| Module bundler can't import a workspace package or Zod | Pass 0 spike; keep module validation self-contained |
| Node type stripping refuses `.ts` under `node_modules` | Workspaces symlink to real paths; fall back to `tsx` for the runner and tests |
| A Maincloud schema migration breaks | Freeze the schema in Pass 0; additive changes only; generic JSON payloads |
| Nemotron tool calling is unreliable, or the ~40 requests/min limit bites | ≤ 12 calls per job; fixed-sequence fallback; lightning-model fallback |
| The simulation is too slow at 500 actors | Spatial hash; profile; drop to 300 |
| Merge pain with the partner | Early Pass 0 merge; merge `main` often; the façade boundary |

## 13. Human action items

- [ ] **Cody:** `spacetime login` (Maincloud) once the CLI is installed.
- [ ] **Cody:** create an NVIDIA API key at build.nvidia.com and put it in `services/runner/.env` as `NVIDIA_API_KEY`.
- [ ] **Cody + partner:** walk through [docs/PARTNER_SYNC.md](docs/PARTNER_SYNC.md).
- [ ] **Cody + partner:** choose the web host (Vercel?).

---

## 14. Decision log

| # | Date | Decision |
|---|---|---|
| D1 | 11-07 | The product is renamed Contra → **Egress**. |
| D2 | 11-07 | **Two lanes:**<br>• Backend: Cody + Claude on `implement-backend`.<br>• Frontend: davidssien, building the ExitCraft UI on `main`.<br>ExitCraft's 3D + SVG frontend replaces the spec's Konva plan. |
| D3 | 11-07 | Next stays at the repo root. npm workspaces. Tests use `node --test`. |
| D4 | 11-07 | **Canonical model:**<br>• A spec-style vertex graph in `{x, y}` with +y north.<br>• Openings are separate entities and include `exit`.<br>• `Floor` holds level metadata only.<br>• Rooms and the boundary are derived.<br>ExitCraft's segment model goes on the partner discussion list. |
| D5 | 11-07 | Corners are computed (miter / hub / cap / bevel), with no corner assets. Furniture comes later, via `content/prefabs.json` plus Kenney CC0 GLBs. |
| D6 | 11-07 | One pure `applyEdit` runs optimistically on the client and authoritatively in the reducer. Undo, redo, imports and proposals all use `applyPatch`. |
| D7 | 11-07 | **Modes:** Edit / Live / Analysis tabs at the top, with the toolbar switching per mode (§8). |
| D8 | 11-07 | **No custom WebSocket.**<br>• Frames are stored as gzip chunks in SpacetimeDB and delivered by session-scoped views.<br>• The runner only connects outward and also hosts the agent. |
| D9 | 11-07 | **Collaboration:** project members with owner / editor / viewer roles, and hashed invite codes. No groups. |
| D10 | 11-07 | Geometry and scenarios are stored as generic JSON rows in `entities` / `scenarios`, validated by Zod. Access, runs and agent data use typed tables. |
| D11 | 11-07 | `EgressDocument v1` is the one format for fixtures, import/export, snapshots and agent I/O. `layoutHash` is the SHA-256 of its canonical JSON. |
| D12 | 11-07 | Binary data is stored as gzip bytes (`t.array(t.u8())`). The wire codec quantizes positions to centimeters. |
| D13 | 11-07 | **Simulation model:**<br>• Simplified social force.<br>• Per-exit grid distance fields.<br>• Token-bucket portals at 1.3 persons/m/s.<br>Congestion modelling comes first; everything else layers on top. |
| D14 | 11-07 | **Live time bar:**<br>• Skip buttons jump ±10 simulated seconds.<br>• The scrubber runs to the LIVE edge.<br>• User runs are paced at 1×, 2× or 4× real time; agent runs are unpaced.<br>• Pause and scrubbing happen only in the client. |
| D15 | 11-07 | **Heatmaps:**<br>• The client computes the live overlays from frames, using the shared `@egress/sim` code.<br>• The runner stores the authoritative final aggregates. |
| D16 | 11-07 | Floor-plan image detection is deferred to a Pass 4 stretch goal and isn't a primary target. |
| D17 | 11-07 | **Merging:**<br>• Pass 0 merges into `main` early.<br>• `main` merges into our branch after each partner commit.<br>• The full merge back into `main` happens after Pass 2. |
| D18 | 11-07 | The original contracts file is reference only; this plan supersedes it. |
| D19 | 11-07 | New entity IDs derive deterministically from `requestId` (`${requestId}.${n}`). Proposals are applied with `requestId = proposalId`, so the IDs match their ghost previews. |
| D20 | 11-07 | The agent defaults to `nvidia/nemotron-3-super-120b-a12b`, with `nvidia/nemotron-3.5-lightning-30b-a3b` as fallback. |
| D21 | 11-07 | **Runner identity:** the runner registers itself once with `register_service(secret)`. The module stores only the secret's SHA-256, and the secret lives in `services/runner/.env`. This replaces the hard-coded identity allowlist in §5, so the runner can move to another machine without a republish. |
| D22 | 11-07 | **Views:** SpacetimeDB 2.14 supports view parameters on the server, but the client subscription syntax for them is unverified. We keep the `sessions`-scoped views, written as query-builder semijoins so they stay incremental. Runner views are procedural and gated on `service_identities`. |
| D23 | 11-07 | **Toolchain findings:**<br>• Node type stripping works through npm-workspace symlinks, which resolves the §12 risk.<br>• Turbopack transpiles workspace packages automatically, so `next.config.ts` is unchanged.<br>• Binary columns use `t.byteArray()`.<br>• The root `tsconfig.json` excludes `spacetimedb/`, `services/` and `docs/`. |
| D24 | 11-07 | **Agent-started runs:** `start_agent_run` creates candidate and baseline runs already claimed by the runner. They use the normal chunk and result reducers, so they appear as ordinary runs. |
| D25 | 11-07 | **Overlapping walls are reused, not rejected.** Drawing over an existing collinear wall reuses it and only adds the uncovered stretch, so the box tool can draw adjacent rooms. This replaces ExitCraft's "overlap rejected" rule. |
| D26 | 11-07 | **Navigation respects thin walls.** Walls are thinner than a 0.25 m cell, so every step between cell centers that crosses a wall edge is blocked. Path costs grow within 0.35 m of a wall, so routes run through the middle of openings. Dijkstra runs in float64. |
| D27 | 11-07 | **Jam handling.**<br>• Walls repel from the single closest point only.<br>• Stalled people yield to the lower index.<br>• Someone stalled 2 s next to an opening turns sideways (0.13 m contact radius for 6 s).<br>• Exits are detected by position, and separation can never push anyone through a door or exit.<br>Every seed of every fixture now evacuates completely. |
| D28 | 11-07 | **The mock client runs the real model.** It runs `@egress/sim` and `@egress/agent` in the browser (client-cpu). This is the guaranteed demo path if SpacetimeDB or Nemotron are unavailable. The runner runs the same code server-side. |
| D29 | 11-07 | **Agent design:**<br>• `get_hotspots` returns validated `suggestionId`s, and the model picks among them rather than authoring geometry.<br>• `test_edit_batch` reruns the baseline's exact people.<br>• Candidates are ranked by effective time: a timed-out run counts 10 s per person still inside.<br>• `runLlmAgent` falls back to the heuristic sequence on model errors. |
| D30 | 11-07 | **Painting** sets per-cell relative weights in [0, 4]. Strokes apply per cell (no blur through walls), erase restores 1, and N never changes. |
| D32 | 11-07 | **Editing and textures:** editing is top-down only, with free-look 3D for viewing after editing, in a blueprint style (blue floor, white lines). Walls gain an optional per-side `finish` (texture IDs) for future textures; it is visual only, and older documents stay valid. |
| D33 | 11-07 | **Dot grid:** the plan view is a grid of dots, with thin walls built along grid lines between dots. Backend unchanged: dots are the 0.25 m snap points. |
| D34 | 11-07 | **Local SpacetimeDB:** run a local server for development; Maincloud is for the demo. Bindings are generated with `--import-extension ts` so the runner can import them under Node type stripping, and are committed so the frontend lane needs no CLI. |
| D31 | 11-07 | **Edit-mode estimate:** route demand is the floor area whose shortest route passes through each cell, smoothed within rooms; exit distance is also available. It is labelled a potential-bottleneck estimate, never congestion. |
