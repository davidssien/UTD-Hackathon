# Egress — Master Plan

**Owner:** Cody (backend + integration) with Claude · **Frontend:** davidssien · **Rebuilt:** Sun 2026-11-08, after `STABLE-V1`

This file holds **priorities, the work ahead and decisions**. Reference material lives elsewhere:

| What | Where |
|---|---|
| Contracts: architecture, domain model, persistence, simulation, runner/agent, UI contract and `@egress/client` API. Sections keep their old numbers (§3–§8). | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| People-flow math (update in the same commit as any `PARAMS` change) | [docs/PEOPLE_FLOW_MODEL.md](docs/PEOPLE_FLOW_MODEL.md) |
| Studio controls and URLs as built | [docs/DEMO_UI.md](docs/DEMO_UI.md) |
| Hosting on the home desktop at `dontrepeatyourself.dev` | [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) |
| The STABLE-V1 plan, unchanged (timeline, passes 0–5, history) | [docs/history/PLAN-STABLE-V1.md](docs/history/PLAN-STABLE-V1.md) |

---

## Status — `STABLE-V1` (`main` @ `60868ea`, tagged)

**Works today**
- **Edit:** top-down CAD editing on a planar wall graph (walls, rooms, doors, windows, exits, erase, undo/redo, snapping, dimensions, inspector, wall types).
- **Simulate:** the egress-pedestrian v0.1 model on the server. The run streams with a LIVE edge and plays back at 1×/2×/4×. It ends when everyone reachable is out, the flow stabilizes, or a safety cap is hit.
- **Analysis:** the agent measures a baseline, tests candidate edits on the same crowd, and re-tests the winner on three crowds. Suggestions glow blue on the model with reason bubbles. Accept applies them.
- **Layers:** people as dots, or as a heatmap of density or congestion.
- **Projects:** live on SpacetimeDB (Maincloud `egress-dev`); the browser keeps only its token. A runner with Nemotron (Lightning) serves Maincloud.
- **Hackathon:** submission uses `STABLE-V1` unless `STABLE-V2` passes its gate first.

**What the feedback on STABLE-V1 changed** (Cody, 2026-11-08):
- The agent ignores what was asked and always chases the worst bottleneck.
- Rooms need recognizing, with an escape plan per real room.
- The project must be public at `dontrepeatyourself.dev`, served from the home desktop. Secrets move to `.env` files.
- A full-page saves screen becomes the landing page.
- Display: a black background trial; right panes collapse like the left rail; Layers must not collide with the pane; the heatmap must be smooth in time and space; no sparkle icon.
- Floor surfaces return, with wood / basic / tile materials.
- Multiple floors with stairs.
- Fire, after an airflow layer and smoke.

---

## 1. Ground rules

- **`main` is the trunk and only moves at green points.** Development happens on `backend-passes` (the dev branch). When a pass is green, fast-forward `main`. Each major milestone gets a `STABLE-Vn` tag. Never force-push. `implement-backend` is merged and retired.
- **One boundary:** the UI talks to the backend only through `@egress/client`. **One data model:** `@egress/core` (Zod schemas are the source of truth).
- **Numbers come from the simulation.** The agent never invents a metric. Copy says "modeled", never "safe" or "compliant"; compliance checks are labelled as modeled checks.
- **Server-only project storage** (D58). The browser stores only the SpacetimeDB token.
- **Secrets only in gitignored `.env` files**, each with a committed `.env.example` that has the keys and no values.
- **Additive schema changes only.** Add new tables and views; never change existing table columns. New entity kinds ride in the existing JSON `entities.payload` rows.
- **Next.js 16 differs from training data.** Read `node_modules/next/dist/docs/` before writing Next code.
- **Every pass ends green:** tests, typecheck, a browser check of the changed UI, and the docs above updated.

---

## 2. Priorities

**`STABLE-V2` gate.**
- https://dontrepeatyourself.dev serves Egress from the home desktop: web, SpacetimeDB and the runner.
- The saves page is the landing page.
- The display fixes are in.
- The agent answers the question that was asked.
- Real rooms get escape plans.
- Floor surfaces have materials.
- Multiple floors with stairs work: people walk down stairs and out.

**`STABLE-V3`:** airflow particles, then smoke, then fire, combined into hazard evacuations.

| # | Workstream | Target | Why now |
|---|---|---|---|
| A | Display fixes | V2 | Small, visible, and unblocks every review. |
| B | Saves landing page | V2 | It's the front door of the public site, and its JSON export/import is how projects move off Maincloud. |
| C | Hosting, secrets, sharing | V2 (**required**) | A public domain is mandatory for V2; other people need to see projects. |
| D | Agent that answers the question | V2 | It's a correctness bug in the headline feature. |
| E | Rooms and escape plans | V2 | New capability that builds on D's layout grounding. |
| F | Floor surfaces, multiple floors, stairs | V2 | Cody asked for floors in the next major pass. Floor surfaces come first. |
| G | Airflow → smoke → fire | V3 | Airflow must exist before smoke, and fire needs both. |

---

## 3. Workstreams

### A. Display fixes

1. **Black background trial.** Try black as the primary scene colour: ground `#0b0c0e`, white dots at lower alpha, room tint 5% white, walls stay light, heatmap and suggestion-blue unchanged. Keep the blueprint blue as a theme token (`?theme=blueprint`) until Cody picks one.
2. **Collapsible right pane, mirroring the left rail.** In Simulate and Analysis (and the Edit inspector), the pane has a pull tab on the right edge. Collapse slides it out to the right and leaves the tab, just as the left rail does. The state is remembered per mode in `localStorage`; that's a viewer convenience, not project data.
3. **Layers never collides with the pane.**
   - The right side becomes one column. The top row holds presence and the Layers button.
   - Opening Layers expands it as a panel at the top of that column, at the pane's width. The context pane stacks below it and shrinks to the remaining height.
   - Nothing floats over anything. If the pane is collapsed, Layers opens alone.
4. **Smooth heatmap, in time and space.**
   - *Time:* fields arrive at 2 Hz. Keep the two samples around the playhead and blend them in the shader by the fractional time (lerp). The heat changes smoothly during playback and scrubbing.
   - *Space:* upload the field as a float texture and sample it bicubically in a fragment shader, then apply the palette after interpolation. This gives smooth curves instead of 0.25 m squares.
   - Walls stay crisp: the walkable mask is sampled separately, so heat never bleeds through a wall. Optional thin iso-contour lines at palette stops.
5. **Chat bar:** remove the sparkle icon.
6. **Small fixes:**
   - Keep the drawing dimension label inside the viewport.
   - Hide tooltips while a menu is open.
   - Make the readout show the playhead's metrics where available, not only the live edge's.

*Done when:* in a browser at 1440×900 and 1024×768, opening Layers in Simulate and Analysis never overlaps the pane; both panes collapse and restore; the heatmap plays smoothly with no visible cells; Cody has picked black or blueprint.

### B. Saves landing page

**UI**
- `/` opens a full-page **saves screen**: the current Projects modal, grown to the whole page.
- **Header:** a logo placeholder (an empty rounded box for now) and **"Egress"** in green, in the studio font (Inter / system stack, 600).
- **Left: the project list.** Owned projects first, then "Shared with you". Columns: name, role, **size (KB)**, last edited.
  - Each row has a **download JSON** button.
  - Row menu: Rename, Delete (owner only).
  - Header actions: New project, Import JSON, Import plan image.
- **Right: the selected project's breakdown.**
  - Top: the floor plan rendered **black on white**, as an SVG from the wall polygons, one image per floor.
  - Details beneath: floors; walls, doors, windows and exits; size; your role; members; created and edited dates; the last run's evacuation time if any.
  - A big blue **Open** button at the bottom right. **Double-clicking** a row also opens it.
- **Open:** the saves screen **slides left** and reveals the editor. Each editor UI element **slides in from its nearest edge**: the mode switch and project chip from the top, the rail tab from the left, the pane and Layers from the right, the dock from the bottom. The scene itself doesn't move.
- **Back to saves:** "Saves" (rail and project chip) slides everything back to the right.

**Backend** (additive)
- A `project_stats` table, written inside the document save path: size in bytes of the canonical JSON, counts per entity kind, floor count and revision. A `my_project_stats` view shows it for projects you're a member of.
- A `session_preview` table and a `preview_entities` view, so the saves page can render and download any of your projects without opening it.
- Client API: `projectStats: Store<ProjectStats[]>`, `previewProject(id): Promise<EgressDocument>`, `renameProject`, `deleteProject`, and `importProject(name, json)`, which validates with `parseDocument` and creates a project seeded with it.

*Done when:* a fresh visitor lands on saves, creates a project, and sees its size, plan and counts. Download then re-import round-trips the same document; open and back slide correctly; the e2e covers preview and stats.

### C. Hosting, secrets and sharing — required for `STABLE-V2`

**Topology** (one Windows desktop). Step-by-step setup is in [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

| Component | Runs as | Listens | Public |
|---|---|---|---|
| SpacetimeDB standalone 2.14.1 | service | `127.0.0.1:3010` | `wss://db.dontrepeatyourself.dev`, client routes only |
| Runner (sim + Nemotron agent) | service | outbound only | — |
| Web (Next.js production build) | service | `127.0.0.1:3100` | `https://dontrepeatyourself.dev` |
| Cloudflare Tunnel (`cloudflared`) | service | outbound only | Provides TLS, hides the home IP, needs no port forwarding |

**Secrets and configuration**

| File (gitignored) | Keys |
|---|---|
| `services/runner/.env` | `EGRESS_SERVICE_SECRET`, `NVIDIA_API_KEY`, `NEMOTRON_MODEL`, `SPACETIME_URI`, `SPACETIME_DB` |
| `.env.deploy` (repo root) | `SPACETIME_SERVER_URL`, `SPACETIME_DB`, `SPACETIME_PUBLISH_TOKEN` |
| `frontend/.env.local` | `NEXT_PUBLIC_EGRESS_SPACETIME_URI`, `NEXT_PUBLIC_EGRESS_SPACETIME_DB` |

- **The runner already loads `services/runner/.env`**, so `NVIDIA_API_KEY` belongs there rather than in a shell variable.
- **No interactive `spacetime login`.** The home server issues a *publisher identity* once (`POST /v1/identity`), and its token goes into `.env.deploy`.
  - `npm run deploy:module` runs `spacetime login --token` and `spacetime publish` against a project-local CLI config (`--config-path`), so nobody's personal login changes.
  - Verified 2026-11-08: a server-issued token published a throwaway database to the local server.
  - That identity owns the database. Store the token in a password manager: without it, the module can't be updated.
- **The studio's default backend comes from env.** No more hard-coded Maincloud. `?backend=` stays for development.
- **Lock down the public SpacetimeDB.** A standalone server lets any identity publish new databases. Expose only the routes the browser uses:
  - creating an identity (`POST /v1/identity`)
  - the WebSocket subscribe route for the `egress` database
  
  Deny everything else at the edge, with a Cloudflare WAF rule or a small proxy allowlist. Confirm the exact routes from the browser's network panel before locking down.
- **Moving off Maincloud.** Browser identities differ per server, so ownership doesn't carry over. Owners download JSON from the Maincloud saves page and import it on the new site. Maincloud stays up as a fallback until V2 is tagged.

**Sharing** (the Plan v2 collaboration follow-ups)
- One **permanent share link** per project (a `project_links` table) and `join_by_link`. Joining always gives **viewer** access.
- **Owners** promote or demote anyone: a members list in the Share modal, through the existing `set_member_role`. Every owner sees the project in their saves.
- **Presence:**
  - Backend: an `online_connections` table maintained by connect/disconnect, and an `active_presence` view.
  - UI: a person icon with a count at the top right; hovering lists the tokens.

*Done when:*
- A phone on cellular data opens https://dontrepeatyourself.dev, creates a project, and runs an evacuation on the home runner.
- A second device opens the share link and joins as a viewer. Presence shows 2. The owner promotes them to editor and their edits sync.
- A desktop reboot brings everything back with no manual steps.
- A publish attempt from outside is refused.

### D. An agent that answers the question

**Problem.** On the Courtyard study, asking for a better door placement always puts the door on the room, even when the user names the far end of the hallway from the other door.

**Causes**
1. The heuristic planner ignores the prompt.
2. `get_hotspots` only offers bottleneck fixes (widen an exit, add a door near the congested room).
3. The model can only pick among those suggestions; it can't place an opening where the user asked (D29).
4. `inspect_layout` doesn't describe walls relative to rooms or hallways, so "opposite end of the hallway" can't be resolved.

**Design**
1. **Intent first.** The request is one of:
   - `targeted_edit`: a named element or placement
   - `improve`: open-ended, so the worst bottleneck
   - `question`: measure or explain only
   - `compare`
   
   Nemotron expresses intent through its tool choices. The heuristic fallback gets a small keyword router so it never silently swaps the request for the bottleneck fix.
2. **Grounded layout.** `inspect_layout` returns, for each wall: its rooms on each side (with labels from E), whether it's exterior, its length and its openings with offsets. Hallways are marked.
3. **Authoring within limits.**
   - `place_opening({ kind, widthM, wallId, offsetM | at: 'start'|'center'|'end' | farthestFrom: openingId })` and `move_opening`. Core validates them: inside the wall, no overlap, minimum widths.
   - Candidates still go through `test_edit_batch` with the same crowd, and through `confirm_candidate`.
4. **Answer what was asked.** Measure and propose the requested edit even if it doesn't help, and say so with the number. Offer the bottleneck fix as a separate second proposal, for example: "you asked X: +2.1 s; the bottleneck fix: −40 s". A job may submit up to 2 proposals.
5. **Compliance and several edits per proposal** (carried over).
   - A `check_compliance` tool runs modeled checks:
     - door clear width ≥ 0.81 m
     - corridor ≥ 1.12 m
     - exits vs occupant load
     - longest travel distance
   - A batch of non-conflicting winners is combined, re-tested, and given one reason per command.

*Done when:*
- On Courtyard, "put a door at the opposite end of the hallway from the existing door" proposes an opening on the hallway wall farthest from that door, with its measured effect.
- "Fix the worst bottleneck" still widens the exit.
- Both are covered by scripted-LLM tests and heuristic-router tests, and checked in the browser with Nemotron.

### E. Rooms and escape plans

**Room recognition**
- Closed shapes already come from `deriveLayout(doc).topology.rooms`.
- When the set of rooms changes, the client calls `request_room_labels`. The runner sends Nemotron one batch of room descriptors:
  - area, width, length and aspect ratio
  - doors and exits
  - neighbouring rooms
  - exterior walls
  - whether it contains an exit
- It gets back `{ roomHash, kind: room | hallway | stair | closet | lobby | other, name, confidence }`.
- **Fallback rules** when there's no key or the call fails: hallway if the narrow side is ≤ 2.4 m and the aspect ratio is ≥ 3, or if it connects ≥ 3 rooms; otherwise room.
- Labels are stored in a `room_labels` table keyed by `(projectId, roomHash)`. The hash is the room's polygon, so unchanged rooms keep their labels across edits.
- Selecting a room in Edit shows its label; the user can override the kind and name.

**Escape plans** (a new left-rail item)
- One plan **per valid room**. Hallways, stairs and closets get none.
- Each plan:
  - a top-down render of the floor with the room highlighted and a "You are here" marker
  - a **primary route** from the room's door to the best exit
  - a **secondary route** through a different exit
  - distances and walking time at 1.34 m/s
- Export is PNG/PDF.
- **Routes** come from per-exit distance fields on the nav grid (`escapeRoutes(compiled, room)` in `@egress/sim`).
- Later, routes avoid fire zones (G) and include stairs (F).

*Done when:* on Courtyard, the two rooms are labelled rooms and the corridor is labelled hallway. Exactly two plans exist, each with primary and secondary routes, and they export.

### F. Floor surfaces, multiple floors and stairs

**Floor surfaces (first; requested 2026-11-08)**
- A new `slab` entity: `{ id, floorId, polygon, material: 'wood' | 'basic' | 'tile' }`. *Basic* uses the same plain look as the walls.
- Edit gets a **Floor** tool:
  - drag a rectangle
  - or click inside a room to fill it
  - right-click the tool to pick the material, just like walls
- Looks come from the same Blender manifest under a new `floors` section.
- **Walkable area:** on the ground floor, rooms stay walkable (older documents keep working) and slabs add surface. On upper floors, **only slabs are walkable**, minus stair openings.

**Multiple floors**
- **UI:**
  - A floor switcher in the bottom-left corner: `‹  Floor 1  ›`. On the top floor, `›` becomes `+` (add a floor).
  - Clicking the label opens floor settings: name, **floor-to-floor height** (the floor's ceiling height, used for everything on it), delete.
- **View:**
  - Edit is top-down on the current floor.
  - Floors below render ~45% darker; floors above are hidden.
  - **The dot grid rises to the current floor's elevation, while the ground plane stays at 0.**
- **Domain** (additive):
  - floor commands `createFloor`, `updateFloor`, `deleteFloor`
  - the `stair` entity
  - all as JSON entity rows, so no table migration

**Stairs**
- **Drawing:** drawn as a rectangle, like Room, on the lower floor. An arrow on one edge marks the up direction (click it or press R to rotate). Each stair connects floor N to floor N+1.
- **Rendering:** steps rising across the rectangle. Risers = round(floor height / 0.175 m). The floor above shows the opening.
- **Simulation:**
  - Compile every floor; stairs link the floor grids.
  - People on upper floors route to stairs and **walk down** them more slowly. Starting values: 0.6 m/s along the run and 1.0 persons/m/s capacity. They come out on the lower floor and continue to exits.
  - Actor flag 2 ("transitioning") means "on stairs".
  - Frames gain a per-actor floor index (frame codec v2).
  - Upward routing is out of scope.
  - The math goes into PEOPLE_FLOW_MODEL.md before the code.

*Done when:* a two-floor fixture with one stair evacuates fully, with people visibly descending. Switching floors darkens the floor below and raises the grid. Slabs render in all three materials, and upper-floor walkability follows them. Escape plans on floor 2 route via the stairs.

### G. Hazards: airflow → smoke → fire (`STABLE-V3`)

1. **Airflow layer.** A coarse per-floor 2D flow field driven by openings (doors open or closed, windows) and configurable inflows, solved with a stable-fluids style step on the 0.25–0.5 m grid. Shown as moving particles or streaks under Layers → Airflow, using fields `air.velocity` and `air.flowMagnitude`.
2. **Smoke.** Concentration is carried by the airflow and spreads; sources are fires. It's a **time-based hazard**: visibility and walking speed fall, and an exposure dose accumulates.
3. **Fire.**
   - **Painted** fire zones, with the same brush as population painting (Simulate pane: Paint People | Fire).
   - Fire spreads **through rooms**, independent of material:
     - growth within a room follows a t² curve
     - cells ignite after an exposure time
     - spread passes through open doors; closed doors delay it
   - It's an **immediate hazard**: burning cells are impassable and people re-route.
4. **Combined hazard evacuation:**
   - people avoid fire and are slowed by smoke
   - metrics add exposure
   - escape plans avoid fire
   - fire is a new evacuation type in the scenario (`scenario.elements` is already reserved)

**Before G:** the population painting UI (the backend has existed since D30) ships in V2, because fire painting reuses the brush.

---

## 4. Pass sequence

| Pass | Contents | Gate |
|---|---|---|
| 6 | A (display) + the B UI shell, then the B backend (stats, preview, import) | A and B done-when lists |
| 7 | C: env-driven endpoints, deploy script, the home server live, sharing and presence | C done-when list from a phone on cellular data |
| 8 | D: agent intent, grounded layout, placement tools, compliance | D done-when list, with Nemotron |
| 9 | E: room labels and escape plans | E done-when list |
| 10 | F: slabs and materials, then floors and stairs (core, then sim, then UI), plus population painting | F done-when list |
| 11 | Harden, final review and docs; fast-forward `main` and tag **`STABLE-V2`** | Every V2 gate on the public site |
| 12+ | G: airflow, then smoke, then fire; tag `STABLE-V3` | — |

Pass 7 can start alongside 6 (it's mostly setup on the desktop); it needs B's JSON import before moving projects off Maincloud.

---

## 5. Testing

- `npm run test:backend` (core, sim, agent, client, runner) and the frontend `npm test`. Keep both green. *Known:* `real-plans.test.ts` from main `6780c69` fails one case; the frontend lane owns it.
- E2E against a local SpacetimeDB: `e2e:local`, `e2e:client`, `e2e:multiuser`. New flows (stats, preview, links, presence, rooms, floors) each add a step.
- Browser check of every changed UI at two sizes. Agent changes are also checked with Nemotron, not only the heuristic.
- Determinism: frame hashes per seed. A model change updates PEOPLE_FLOW_MODEL.md in the same commit.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Home internet or power goes down during the demo | Keep Maincloud running until after the demo; the runner can serve both. A UPS is worth having. |
| The public SpacetimeDB is abused (publishing, spam projects) | Edge route allowlist; publisher token offline; per-identity project limits if needed |
| Losing the publisher token | Password manager plus a sealed backup; document how to republish under a new name |
| Nemotron mislabels rooms | Rule fallback, confidence shown, user override |
| Multi-floor sim takes longer than planned | Ship floor surfaces and floors in the UI first; the sim allows down-only stairs and one stair per pair of floors to start |
| Smooth heatmap costs too much GPU | One bicubic sample per pixel at playback resolution; fall back to linear filtering |

## 7. Human action items (Cody)

- [ ] Confirm where `dontrepeatyourself.dev` is registered. Add it to a free Cloudflare account and switch the nameservers ([SELF_HOSTING.md](docs/SELF_HOSTING.md) §1).
- [ ] On the desktop: put `NVIDIA_API_KEY` into `services/runner/.env` (from `.env.example`).
- [ ] Create the publisher token (SELF_HOSTING §4) and keep it in a password manager.
- [ ] Set the desktop to never sleep, use wired ethernet, and set Windows Update active hours around demos.
- [ ] Pick black or blueprint after the Pass 6 trial.

## 8. Open questions for Cody

1. **Background:** replace blueprint with black, or keep both as a setting?
2. **Escape plans:** is PNG enough, or is a printable PDF needed? Are secondary routes wanted on every plan?
3. **Stairs:** down-only for evacuation? (Assumed yes.) Any outdoor stairs or ramps?
4. **Upper floors:** should walls placed on floor 2 require a slab underneath, or warn?
5. **Fire:** realism target. Fire-modeling grade (t² growth, smoke dose) or a believable visual first?

---

## 9. Decision log

D1–D63 are carried over unchanged from `STABLE-V1`; D64 onward come from the rebuild. Where an older entry conflicts with a newer one, the newer one wins.


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
| D35 | 11-07 | **Heatmap layers:** People flow is live now and Air flow is reserved. Per-layer options pick the field, aggregation, actors on/off and granularity (`downsampleField`). |
| D36 | 11-07 | **Live-mode restarts:** Live allows only distribution and element changes, and both require a restart via a dedicated Stop. Cancellation lands within ~100 ms even while the runner paces ahead. `scenario.elements` (fire) is reserved and ignored by v0.1. |
| D37 | 11-07 | **Model math is recorded** in [docs/PEOPLE_FLOW_MODEL.md](docs/PEOPLE_FLOW_MODEL.md). Any change to a `PARAMS` value or formula must update that file in the same commit. |
| D38 | 11-07 | **Run end:** a Live run ends when the flow has stabilized, not at a fixed time.<br>• `all-out`: every reachable person has left.<br>• `stabilized`: 10 s with no exits and the people still inside averaging under 0.05 m/s.<br>• `timeout`: safety cap only.<br>It's cheap (O(N) per tick) and reported as `metrics.endReason`. Circulate will reuse the window with occupancy/field-change signals. |
| D31 | 11-07 | **Edit-mode estimate:** route demand is the floor area whose shortest route passes through each cell, smoothed within rooms; exit distance is also available. It is labelled a potential-bottleneck estimate, never congestion. |
| D39 | 11-07 | **One 3D baseline:** every asset is 3D and top-down Edit uses the same scene, with no secondary 2D visual model. Leaving Edit transitions to isometric/freecam. A top-left viewcube reflects orientation; freecam stays above the floor. Dither only walls/attached wall detail that obscure the floor. Furniture stays opaque. Client-only implementation is deferred. |
| D40 | 11-07 | **Asset workflow:** Blender supplies GLB materials/modules for normal/reinforced/glass walls and later furniture. Shared wall outlines/openings remain authoritative; keep procedural junction closures. Furniture/placeables later validate against walls and opening clearance; wall edits are not blocked by furniture. No schema expansion now. Details in `docs/3D_ASSET_PLAN.md`. |
| D41 | 11-07 | **Hosted Nemotron verified:** Super was unavailable; `nvidia/nemotron-3.5-lightning-30b-a3b` accepted tools and thinking-off requests. A real browser job completed as `llm` with 9 tool calls and one measured proposal, without fixed-step fallback. Runner-only `NVIDIA_API_KEY`; pin Lightning for the verified dev setup. |
| D42 | 11-07 | **Measured proposal enforcement:** the tool rejects non-improving candidates using the existing heuristic threshold and rejects a mismatched baseline. Prompt requires saving an improving proposal before claiming it exists. This closes a live-verification gap without changing contracts. |
| D43 | 11-07 | **Maincloud dev:** `egress-dev` published with data preservation, then the real client E2E passed through proposal acceptance. The user approved ongoing runner operation; its background worker is now connected and ready with Lightning. Production/web deployment stays separate. |
| D44 | 11-07 | **UI references retained:** original GUI notes, seven working prototype files and five sketches are archived unchanged in `docs/reference/gui`. `docs/UI_REFERENCE.md` maps their layout to current modes and records superseded/deferred behavior. Treat embedded historical prompts as reference content, not new backend instructions. |
| D46 | 11-07 | **Parallel agents on one machine:** backend passes run in the git worktree `.claude/worktrees/backend-passes` on branch `backend-passes`, branched from `implement-backend@1c1cd88`, and publish to a separate local database, `egress-backend`. The demo UI work in the main checkout, `egress-local` and Maincloud `egress-dev` are untouched until the branches are merged. |
| D47 | 11-07 | **Runner heartbeat:** the runner pings `runner_heartbeat` every 5 s. `runner_status` (no project data) feeds `EgressClient.runner`, which is online if a heartbeat arrived within 20 s. The UI shows "simulation server offline" instead of an endless "queued". The mock is always online. |
| D48 | 11-07 | **Replays use the run's frozen layout:** `active_run_layout` exposes the snapshot of the caller's active run, and playback heatmaps compile against it, so an accepted proposal no longer distorts older replays. |
| D49 | 11-07 | **Before/after comparison:** `open_compare` + `active_compare_results` + `EgressClient.compareRuns(baseline, candidate)` return both runs' metrics, `metricsDelta`, and a congestion difference map. The delta math now lives in core and is shared with the agent. |
| D50 | 11-07 | **Three-seed robustness:** the agent re-tests the winning change on two more crowds (`confirm_candidate`) and only proposes it if the mean improves. The spread is part of the evidence. |
| D45 | 11-07 | **Runner token isolation:** Maincloud rejected the legacy local token with 401. Persist tokens by URI/database in separate gitignored files and leave the legacy file untouched. Maincloud startup and reconnection with the saved cloud token both passed, retaining the same service identity. No shared contract changed. |
| D51 | 11-07 | **Frontend merge:** current main moved the web app into `frontend/` and added sketch/QR import. Merged into `implement-backend` at `1c1cd88`; this supersedes D3's root app location. Root scripts delegate to the frontend workspace. |
| D52 | 11-07 | ~~**Simple branch demo:**~~ *Superseded by D55.* prioritize top-down editing in the same 3D scene, the transition to freecam and a good viewcube. Keep the top mode selector, switching bottom taskbar and side menu. No modal popups. The left menu collapses through a handle and after every bottom-toolbar action. Styling beyond those patterns remains open. |
| D53 | 11-07 | ~~**Save slots:**~~ *Superseded by D58: no browser-local project storage.* `/` uses a frontend persistence wrapper around the existing mock client to retain multiple canonical layout documents and the active slot in localStorage. Save opens an inline switcher with named Create new. `/?backend=maincloud` uses existing server projects through the same client interface. No shared schema expansion. |
| D54 | 11-07 | **Branch boundary:** demo changes and logical commits remain on `implement-backend`; do not push to main or publish yet. Backend gaps for future furniture/GLB work are recorded in `docs/DEMO_UI.md`. |
| D55 | 11-08 | **UI v2 layout** (Plan.md §8): full-window scene; compact mode switch at top center; presence and Layers at top right; a left pull tab that expands to a meta-action rail; an optional right context pane with a bottom action box; a bottom context toolbar attached to the bottom edge. No taglines; CAD-style tool buttons; modals allowed for Projects, Share and Import. |
| D56 | 11-08 | **Placeholder icons are Heroicons** (`@heroicons/react`), replacing lucide in the studio. |
| D57 | 11-08 | **Cross-hatching replaces dithering** for walls that hide the floor. Never in top-down views; evenly spaced in screen space; furniture stays opaque. |
| D58 | 11-08 | **No browser-local project storage.** Projects live only in SpacetimeDB (Maincloud by default). Browser storage keeps only the SpacetimeDB token that links the browser to its projects. Local save slots are removed. |
| D59 | 11-08 | **Collaboration model:** one permanent share link per project; joining gives viewer access; owners promote anyone; every owner sees the project in their list; people are identified by token; a presence count with hover-for-tokens sits at top right. Backend pieces are the next backend pass; until then Share issues a 14-day viewer invite. |
| D60 | 11-08 | **Parametric vs placeable:** only walls (later counters and similar runs) are parametric. Doors, windows and exits are wall-attached placeables; furniture is floor-placed. |
| D61 | 11-08 | **Agent suggestions:** several edits per proposal, highlighted in blue on the model with one short reason bubble each. The agent weighs compliance checks and measured safety. Compliance tooling and multi-edit batching are the next backend pass. |
| D62 | 11-08 | **Blender wall textures:** a manifest at `frontend/public/assets/walls/manifest.json` maps materials (later `finish` ids) to exported textures with world-scale UVs and a flat-colour fallback. |
| D63 | 11-08 | **Viewcube behaves like a CAD viewcube:** drag it to orbit; click faces, edges and corners for those views; it mirrors the camera. Edit still locks top-down. |
| D64 | 11-08 | **Plan rebuilt after `STABLE-V1`.** Plan.md now holds priorities, workstreams and decisions. The contracts (§3–§8, same numbers) moved to `docs/ARCHITECTURE.md`; the old plan is archived unchanged at `docs/history/PLAN-STABLE-V1.md`. |
| D65 | 11-08 | **Trunk and tags.** `main` fast-forwards from the dev branch `backend-passes` at green points; major milestones get `STABLE-Vn` tags (`STABLE-V1` = `60868ea`). `implement-backend` is merged and retired. |
| D66 | 11-08 | **`STABLE-V2` requires the public site.** https://dontrepeatyourself.dev serves Egress from Cody's home desktop, which also runs SpacetimeDB and the runner. |
| D67 | 11-08 | **Self-hosting topology:** SpacetimeDB standalone on `127.0.0.1:3010`, the runner, a Next.js production server on `127.0.0.1:3100`, and a Cloudflare Tunnel (TLS, no open ports, home IP hidden). The public SpacetimeDB exposes only the browser's routes; publishing is denied at the edge. |
| D68 | 11-08 | **Secrets and publishing.** Each component reads a gitignored `.env` with a committed `.env.example`. Publishing uses a server-issued publisher token (`POST /v1/identity`) through a project-local CLI config (`--config-path`), so nobody needs an interactive `spacetime login`. A throwaway publish with such a token was verified on the local server. |
| D69 | 11-08 | **The saves page is the landing page.** It's a full-page project list with size in KB, JSON download, a black-on-white plan render and details; Open (or double-click) slides to the editor and Saves slides back. Backed by additive `project_stats` and preview views; JSON import is also the Maincloud-to-home migration path. |
| D70 | 11-08 | **Display changes:** a black background trial behind a theme token (blueprint kept until Cody picks); the right pane collapses with a pull tab mirroring the left rail; Layers expands at the top of one right column and the pane shrinks below it, so they never overlap; no sparkle icon in the chat bar. |
| D71 | 11-08 | **Smooth heatmap:** blend the two 2 Hz field samples around the playhead by fractional time, sample bicubically from a float texture and apply the palette after interpolation; a separate walkable mask keeps walls crisp. |
| D72 | 11-08 | **The agent answers the question asked.** Requests are classified (targeted edit, improve, question, compare); `inspect_layout` describes walls by room and hallway; `place_opening`/`move_opening` allow constrained authoring. The requested edit is measured and proposed even if it doesn't help, with the bottleneck fix offered as a second proposal. |
| D73 | 11-08 | **Rooms and escape plans.** Nemotron labels each closed room (room, hallway, stair, closet, lobby, other) from geometric descriptors, with a rule fallback, cached by polygon hash and overridable by the user. Only real rooms get escape plans, each with primary and secondary routes from per-exit distance fields. |
| D74 | 11-08 | **Floor surfaces return:** a `slab` entity with `wood`, `basic` (the wall look) or `tile`, drawn with a Floor tool or filled into a room. Ground-floor rooms stay walkable; on upper floors only slabs are walkable. |
| D75 | 11-08 | **Multiple floors and stairs:** a bottom-left `‹ Floor n ›` switcher with per-floor floor-to-floor height; floors below render darker and floors above are hidden; the dot grid rises with the current floor while the ground stays at 0. Stairs are rectangles with an up edge, rendered as risers; evacuation routes go down only; frames gain a per-actor floor index. |
| D76 | 11-08 | **Hazard order:** airflow particles, then smoke (time-based hazard carried by airflow), then fire (painted zones that spread through rooms independent of material; an immediate hazard). The population painting UI ships in V2 so fire painting can reuse the brush. |
