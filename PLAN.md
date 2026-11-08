# Egress — Master Plan

[Final hackathon sprint and handoff](docs/final-sprint/plan.md)

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

## Status — `STABLE-V1.1` (`6593cd9`, tagged); passes 7–13 on `stable-forward`

**Since `STABLE-V1`:** Pass 6 (§3 T) is done. One root `.env` and `npm run db:*` work against Maincloud `egress-dev` without `spacetime login`, and a partner machine has connected with the shared `.env`. The current module is published to `egress-dev`, and a current runner (heartbeats, Lightning) serves it. The database stays on Cody's Maincloud account (D84); the home desktop will serve only the website and runner (D85). `STABLE-V1.1` tags this state.

**On `stable-forward` since `STABLE-V1.1`** (passes 7–13, not yet on `main`; needs the module published to `egress-dev` first):
- Saves page as the landing page, sharing links, roles and presence; smooth heatmap and a steady LIVE badge; behavior v0.2; an agent that answers the question asked; room labels and escape plans.
- Floor surfaces (wood, basic, tile), stacked floors with a switcher, stairs, and population painting. The simulation still covers the ground floor only (Pass 12b).
- One shared live simulation per project: everyone follows it, editing locks while it runs, the presence chip shows the lock, and presence shows each person's mode.
- Five example saves, from a 16 × 12 m courtyard to a 48 × 20 m school wing and a two-storey clinic.

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
- **First:** a small pass so everyone shares one central `.env` (NVIDIA key and SpacetimeDB credentials) and can use SpacetimeDB without `spacetime login`.
- **Evacuation behavior has two modes:**
  - (a) the deterministic model, fixed so crowds stop flip-flopping between exits, with per-person attention span and patience;
  - (b) an agentic mode where Nemotron estimates human behavior at low cost.
- **A security phase** (IDOR, auth and the rest) before the public tag.

---

## 1. Ground rules

- **`main` is the trunk and only moves at green points.** Development for passes 7–13 happens on `stable-forward`, branched from `STABLE-V1.1`. When a pass is green it can fast-forward `main`, unless the partner's work needs a merge first. Major milestones get `STABLE-Vn` tags. Never force-push. `implement-backend` and `backend-passes` are retired.
- **The partner owns CV floor-plan scanning** (the sketch/photo importer and its `frontend/lib/scan-*`, `sketch-import`, `floorplan` code). We don't build in that area. We keep its seams open and stable:
  - `buildingToDocument(building)` in `frontend/lib/import-building.ts` turns a reviewed scan into an `EgressDocument`.
  - "Import plan image" (rail and saves page) opens the partner's `SketchImporter`.
  - `importProject` / `createProject(name, seed)` store the result.
  
  Expect manual merge work when the branches meet.
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
- One central `.env`: a fresh clone plus the shared `.env` publishes, runs the runner and runs the site, with no `spacetime login`.
- https://dontrepeatyourself.dev serves Egress from the home desktop (website + runner), with the database on Maincloud `egress-dev`.
- The deterministic evacuation model (v0.2) no longer flip-flops: people commit to exits by attention span and patience.
- The security review has passed: the authorization matrix test is green and there are no open high-severity findings.
- The saves page is the landing page.
- The display fixes are in.
- The agent answers the question that was asked.
- Real rooms get escape plans.
- Floor surfaces have materials.
- Multiple floors with stairs work: people walk down stairs and out.

**`STABLE-V3`:** the final sprint release (2026-11-08). **`STABLE-V4`:** the agentic evacuation mode.

| # | Workstream | Target | Why now |
|---|---|---|---|
| T | Team access: one central `.env` | V2, **first** | Everyone needs the same credentials before parallel work; it's small. |
| A | Display fixes | V2 | Small, visible, and unblocks every review. |
| B | Saves landing page | V2 | It's the front door of the public site, and its JSON export/import is how projects move off Maincloud. |
| C | Hosting, secrets, sharing | V2 (**required**) | A public domain is mandatory for V2; other people need to see projects. |
| D | Agent that answers the question | V2 | It's a correctness bug in the headline feature. |
| E | Rooms and escape plans | V2 | New capability that builds on D's layout grounding. |
| F | Floor surfaces, multiple floors, stairs | V2 | Cody asked for floors in the next major pass. Floor surfaces come first. |
| H | Evacuation behavior v0.2 (deterministic mode) | V2 | Crowds shimmying between doors undermine every number the product shows. |
| S | Security review | V2, before the tag | The site becomes public; IDOR and auth gaps must be found first. |
| I | Agentic evacuation mode (Nemotron behavior) | V3 | Needs H's per-person parameters to steer, and a cost budget. |
| G | Airflow and HVAC | V2 | Done in the final sprint: a steady airflow layer for any wind bearing, with HVAC vents. |

---

## 3. Workstreams

### T. Team access: one central `.env` (first pass)

**Goal.** A teammate clones the repo and receives the shared `.env` through a password manager. They can then publish the module, run the runner (with Nemotron) and run the site against the team database. Nobody runs `spacetime login`.

**One file at the repo root** (gitignored), documented by a committed `.env.example`. It replaces the per-component examples added on 2026-11-08 (`services/runner/.env.example`, `.env.deploy.example`, `frontend/.env.example`).

| Key | Used by | Notes |
|---|---|---|
| `NVIDIA_API_KEY`, `NEMOTRON_MODEL` | runner | Server-side only. |
| `EGRESS_SERVICE_SECRET` | runner | Its sha256 is compiled into the module. |
| `SPACETIME_URL` | runner, CLI wrapper, site | The HTTP(S) form, e.g. `https://maincloud.spacetimedb.com` or `http://127.0.0.1:3010`. The runner and browser derive `ws(s)://`. |
| `SPACETIME_PUBLIC_URL` | site | Optional. What browsers connect to when it differs from `SPACETIME_URL`. Unused while the database is on Maincloud. |
| `SPACETIME_DB` | all | e.g. `egress-dev`, later `egress`. |
| `SPACETIME_TOKEN` | CLI wrapper | The database owner's CLI token. Only in the publisher's own `.env`; blank in the shared copy (see below). |

**How each piece reads it**
- **Runner:** `config.ts` loads the root `.env`, then `services/runner/.env` as an optional local override (today's setups keep working).
- **Site:** `next.config.ts` loads the root `.env` and passes **only** the derived public URI and database name to the browser. A test checks the production bundle contains no `NVIDIA_API_KEY` or `SPACETIME_TOKEN` values.
- **CLI:** `npm run db -- <spacetime args>` wraps the CLI with a repo-local config (`.spacetime/cli.toml`, gitignored). It adds the server, runs `login --token $SPACETIME_TOKEN`, then passes your arguments through. Shortcuts:
  - `npm run db:publish` (always `--delete-data=never`)
  - `npm run db:logs`
  - `npm run db:sql`
  
  This was verified on 2026-11-08 with a server-issued token against a local server.

**Which token (decided 2026-11-08, D84)**
- `egress-dev` stays on **Cody's personal Maincloud account**. No new database.
- `SPACETIME_TOKEN` is Cody's CLI token (`spacetime login show --token`) and lives **only in the publisher's own `.env`**. It controls the whole account, so the `.env` shared with others leaves it blank.
- Only owner actions need it: `db:publish`, `db:logs`, owner `db:sql`.
  - The website, the runner and visitors never need it.
  - The runner registers with `EGRESS_SERVICE_SECRET`; browsers get their own identities.
- **Before the public launch, revisit:**
  - Option one: a dedicated team account.
  - Option two: a Maincloud organization. An organization can only be set when a database is created, so this means a new database, with projects moved by JSON export and import (B).

*Done when:*
- ✅ Cody's machine: the root `.env` is complete. Checked 2026-11-08:
  - the token is accepted by Maincloud and owns `egress-dev`
  - `SPACETIME_DB_IDENTITY` matches
  - `EGRESS_SERVICE_SECRET` matches the module's hash
  - `npm run db -- list` and `npm run db:logs` work without `spacetime login`
- ✅ The bundle check passes and is part of `npm run build`.
- ✅ SELF_HOSTING.md follows the central `.env`.
- ⬜ A second machine with only a fresh clone, `npm ci` and the shared `.env` (token blank) runs `npm start -w @egress/runner` (Nemotron answers) and `npm run dev` against `egress-dev`.

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
5. **A steady LIVE badge.** Today the playhead catches the edge, stalls until the next 2 s chunk, and the badge blinks on and off with every chunk.
   - *Follow mode:* after Go live, the playhead trails the edge by a small buffer (one chunk, about 2 s) so it plays continuously instead of stopping at each chunk.
   - *Debounce:* LIVE switches on within 1 s of the edge and stays on until the playhead is more than `n` = 4 s behind or the user scrubs back.
   - The scrubber thumb sits at the front of the timeline while live, and the timeline shows a live-edge marker.
6. **Chat bar:** remove the sparkle icon.
7. **Small fixes:**
   - Keep the drawing dimension label inside the viewport.
   - Hide tooltips while a menu is open.
   - Make the readout show the playhead's metrics where available, not only the live edge's.

*Done when:* in a browser at 1440×900 and 1024×768, opening Layers in Simulate and Analysis never overlaps the pane; both panes collapse and restore; the heatmap plays smoothly with no visible cells; LIVE stays lit through a whole followed run without blinking; Cody has picked black or blueprint.

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

**Topology** (decided 2026-11-08, D85).
- **The database stays on Maincloud** (`egress-dev`); it is not self-hosted.
- **The home desktop serves the website and runs the runner.**
- Step-by-step setup is in [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

| Component | Where | Listens | Public |
|---|---|---|---|
| SpacetimeDB | Maincloud | — | `wss://maincloud.spacetimedb.com`, database `egress-dev`; browsers connect directly |
| Runner (sim + Nemotron agent) | desktop, service | outbound to Maincloud | — |
| Web (Next.js production build) | desktop, service | `127.0.0.1:3100` | `https://dontrepeatyourself.dev` |
| Cloudflare Tunnel (`cloudflared`) | desktop, service | outbound only | Provides TLS, hides the home IP, needs no port forwarding |

**Secrets and configuration**
- Everything comes from the **central `.env`** (§3 T). The desktop needs `NVIDIA_API_KEY`, `EGRESS_SERVICE_SECRET`, `SPACETIME_URL` and `SPACETIME_DB`; it needs `SPACETIME_TOKEN` only if Cody publishes from it.
- The site's default backend comes from that `.env` at build time (done in Pass 6). `?backend=` stays for development.
- Maincloud handles TLS, identities and who may publish, so there is no database lockdown at our edge. Abuse limits on our own reducers are part of the security review (S).
- **The runner is now the single point for runs and the agent.** Only one runner should serve `egress-dev` in production. The desktop's runner replaces the one on the dev machine once the desktop is live.

**Sharing** (the Plan v2 collaboration follow-ups)
- One **permanent share link** per project (a `project_links` table) and `join_by_link`. Joining always gives **viewer** access.
- **Owners** promote or demote anyone: a members list in the Share modal, through the existing `set_member_role`. Every owner sees the project in their saves.
- **Presence:**
  - Backend: an `online_connections` table maintained by connect/disconnect, and an `active_presence` view.
  - UI: a person icon with a count at the top right; hovering lists the tokens.

*Done when:*
- A phone on cellular data opens https://dontrepeatyourself.dev, creates a project, and runs an evacuation on the home runner.
- A second device opens the share link and joins as a viewer. Presence shows 2. The owner promotes them to editor and their edits sync.
- A desktop reboot brings the website, runner and tunnel back with no manual steps.

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
- Routes include stairs (F).

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

*Status (Pass 12, D91):* surfaces, floors, the switcher and settings, stairs (drawn and rendered) and population painting are done. **Still open, now Pass 12b:** the multi-floor simulation (stairs linking floor grids, people descending, frame codec v2), upper-floor walkability from slabs, the stair opening in the floor above, and escape plans on upper floors. Until then the simulation covers the lowest floor and the Simulate pane says so.

### G. Airflow and HVAC (final sprint)

- **Airflow layer.** `floorAirflow(document, floorId, windFrom)` solves steady relative pressure within each connected floor. Open exterior doors and windows take the wind pressure for a bearing chosen on a compass (any of 360°); closed openings are sealed. Shown under Layers → Airflow and measured by the agent's `inspect_airflow`.
- **HVAC.** Ceiling vents are placeables that hold their area at supply pressure and push air toward open outlets; a sealed room stays still.
- **Furniture** (tables, desks, chairs, counters; 0–0.5 m) blocks people but not air.

### H. Evacuation behavior v0.2 — deterministic mode (a)

**What goes wrong today** (`chooseExit`, PEOPLE_FLOW_MODEL §5.2)
- Every person re-picks an exit on the **same tick** (every 2 s), minimizing `D_e/v₀ + Q_e/cap_e`.
- `Q_e` counts only people already **standing near** that exit.
- So when exit A queues, everyone at once sees B as empty and switches. B's queue only builds once they arrive, so they all switch back. The only damper is a 10% hysteresis.
- The result is a crowd shimmying between doors instead of committing.

**Model** (people know the full layout and can reach any exit; the per-exit Dijkstra fields are already exact, so A* adds nothing)

1. **Attention span `τ_i`, staggered.** Each person re-evaluates on their own clock, every `τ_i` seconds (seeded lognormal, median ≈ 6 s, clamped to 2–15 s), with a random phase. Nobody switches in lockstep.
2. **Expected wait counts the people ahead of you, not the crowd at the door.** The wait for exit `e` is the number of people **heading to `e`** who are closer to it than you, divided by its capacity:
   ```
   W_e(i) = |{ j : exit_j = e, D_e(x_j) < D_e(x_i) }| / cap_e
   ```
   Computed per replan from cumulative distance histograms per exit, O(1) per lookup. Committed demand is visible before it arrives.
3. **Perceived cost.** Waiting feels longer than walking. Each person weighs their wait by `κ_i` (seeded, ≈ 1.5):
   ```
   C_e(i) = D_e(x_i)/v_i + κ_i · W_e(i)
   ```
4. **Commitment.** Switch only if the gain beats both an absolute and a relative threshold:
   ```
   C_cur − C_best > max(Δ_abs, ρ · C_cur)        Δ_abs ≈ 3 s, ρ ≈ 0.15
   ```
   - No switching within 4 m of your current exit.
   - After a switch there's a cooldown of `2τ_i`.
5. **Patience `P_i`** (seeded, ≈ 20–90 s, longer for longer attention spans). While queued, waiting time `w_i` accumulates.
   - As `w_i → P_i`, `κ_i` rises and the thresholds fall, so the person becomes willing to walk to a farther exit that "feels better".
   - At `w_i ≥ P_i` they re-evaluate immediately; a further switch then needs a fresh `P_i`.
6. **Seeded and reproducible.** All per-person draws come from the run seed, so the same people make the same decisions, which keeps `test_edit_batch` comparisons fair.

**New metrics:** exit switches per person and a reversal count (A→B→A), so flip-flopping is visible. Shown in the Simulate readout and the agent's run summaries.

**Before code:** write PEOPLE_FLOW_MODEL §5.2 v0.2, with parameters and sources (pre-movement and patience ranges from the evacuation literature). The model id becomes `egress-pedestrian 0.2`.

*Done when:*
- On a symmetric two-exit hall, the reversal count is near zero and queues balance within ±20%.
- On Courtyard, no group visibly shimmies at a door.
- Fixtures still evacuate fully, and evacuation times are within 10% of v0.1 or better.
- Determinism holds.

### I. Agentic evacuation mode (b) — Nemotron estimates human behavior (`STABLE-V4`)

**Why not one LLM per person.** 150–500 people deciding every few seconds means thousands of calls per run. That's far beyond cost and the ~40 requests/min limit, and too slow.

**Design: a director, not a swarm.** The deterministic engine (H) still moves everyone; Nemotron only sets **who wants what**, at a few moments, for groups.

1. **Population profile (one call per run).** Nemotron gets the scenario: building use, occupancy, time of day, alarm type and exits. It returns 4–8 behavior profiles with population shares. Each profile sets:
   - pre-movement delay distribution (time before people start leaving)
   - familiarity (bias toward the entrance used or known exits)
   - attention span, patience and waiting weight (H's `τ`, `P`, `κ`)
   - group size and how tightly a group stays together
   - speed factor
   
   People are assigned to profiles with the run seed.
2. **Event-driven group decisions (≤ 8 calls per run).** Triggers:
   - an exit's expected wait passes a threshold
   - an exit becomes blocked
   - a group has stalled beyond its patience
   
   The runner groups people by room and current exit and sends one compact summary: groups, sizes, room names, waits per exit, what each group can see. Nemotron returns group-level intents, such as "40% of the east-room group head for the north exit; the rest wait". They're applied to members with the seed.
3. **Budget and fallback.** Lightning model by default, temperature 0, Zod-validated JSON, all groups batched in one call. A hard per-run budget: about 10 calls and 20k tokens, shown in the UI. Answers are cached by a situation hash. When the budget runs out, a call fails or no key exists, groups follow the deterministic rules (H).
4. **Reproducible.** Every Nemotron answer is recorded with its tick in the run, a "decision tape". A replay or re-simulation reads the tape, so the run is identical without new calls and doesn't depend on latency. The server can pause simulated time at a decision point; it runs ahead of playback anyway.
5. **Accuracy.**
   - Profiles and outputs are checked against published ranges: pre-movement times, door flow and familiarity effects.
   - Analysis shows agentic and deterministic side by side for the same layout and seed.
   - The decision tape is visible: timeline markers, with bubbles on the groups they affected.

**Contracts** (additive)
- `scenario.behavior = { mode: 'deterministic' | 'agentic', budgetCalls? }`.
- The decision tape is stored with the run result.
- The Simulate pane gets a Behavior choice: Deterministic | Agentic.

*Done when:*
- An agentic run on the hall uses ≤ 10 calls and plays back identically from its tape.
- Without a key it degrades to deterministic.
- The side-by-side comparison shows where behavior differs and why, in the model's own one-line reasons.

### K. Collaborative modes (Pass 13, a headline for `STABLE-V2`)

**Goal.** Everyone on a project works from the same state, whichever mode they're in.

- **Edit:** everyone edits at once (already the case). Server-confirmed optimistic edits; conflicts resolve by order.
- **Simulate:** one **shared live simulation per project**.
  - When anyone starts a run, everyone on the Simulate screen follows the same run. The frames are already persisted in SpacetimeDB (`replay_chunks`) and stream to every subscriber in real time.
  - People joining late catch up from the stored frames.
  - **While a run is in progress the layout is locked:** the server refuses edits. The presence chip turns red with a lock and says why, and the Edit tools are disabled until the run ends or is stopped.
  - Each person keeps their own playhead and speed.
- **Analysis:** shared. Agent jobs, steps and proposals are per project (already true). The open proposal and Accept/Reject are seen by everyone; the first decision wins.
- **Presence by mode:** the chip's hover list shows who is where (Edit / Simulate / Analysis).

**Backend** (additive)
- `project_live` (projectId → current run id, set by `request_simulation` and cleared when the run ends or is cancelled), with the edit lock enforced in `apply_edit`.
- `presence_state` (identity → project and mode, via `set_mode`, cleared on disconnect).

*Done when:*
- Two browsers on one project: B sees A's run start in Simulate without doing anything, at the same LIVE edge.
- A's edit attempt during the run is refused with a clear message, and the chip shows the lock.
- When the run ends, editing unlocks for both.
- Both see the same agent proposal and the same accept.
- e2e-multiuser covers it.

*Status (Pass 13, D93):* done. e2e-multiuser checks presence by mode, B following A's run, the client and the server refusing B's edit, a second run refused, and the unlock after Stop. Accept is locked like any edit; the first decision on a proposal wins as before.

### S. Security review (before the `STABLE-V2` tag)

**Threat model:**
- anonymous public visitors with self-issued identities
- share-link holders
- members at each role
- the runner's service identity
- the Nemotron API
- the home desktop and Cloudflare edge

**Checks**

1. **Authorization matrix (IDOR).** An automated e2e calls **every reducer and view** as each of anonymous, non-member, viewer, editor, owner and runner. It covers both a project the caller belongs to and a foreign one, passing ids that belong to someone else: `projectId`, `runId`, `jobId`, `proposalId`, compare pairs, invite and share codes. Every denial must hold, and views must re-check membership at read time.
2. **Auth and identities.**
   - service secret strength and a rotation procedure
   - runner-only reducers reject everyone else
   - heartbeat spoofing
   - presence shows **identity** hex only, never an auth token
   - browser token storage vs XSS
3. **Share links and invites.** At least 128 bits, no enumeration, revocation, rate-limited joins.
4. **Abuse and DoS limits.** Maximums per identity on projects, entities per project, edit batch size, population, run duration, replay bytes, queued runs and agent jobs; string lengths; storage quotas.
5. **LLM.** Prompt injection through project names, room names and prompts: tools stay allowlisted and Zod-validated, no secrets in prompts, per-job budgets, output is never executed.
6. **Web.**
   - CSP and security headers, `frame-ancestors`
   - no secrets in the client bundle
   - names rendered as text
   - `npm audit`
   - the QR/phone upload routes (`/api/import-sessions`): auth, expiry, size and type checks, path traversal
7. **Edge and host.** SpacetimeDB route allowlist, Cloudflare WAF and rate limits, no admin ports open, Windows firewall, services running with least privilege.
8. **Secrets and data.** `.env` handling, a rotation runbook (NVIDIA key, service secret, publisher token), logs scrubbed, backups protected.

**Outputs:**
- `docs/SECURITY.md`: threat model, findings and fixes.
- The authorization matrix test, run with the e2e suite from then on.

*Done when:* the matrix test is green, there are no open high or critical findings, and medium findings are fixed or accepted in writing.

---

## 4. Pass sequence

| Pass | Contents | Gate |
|---|---|---|
| 6 ✅ | **T: one central `.env`, `npm run db` wrapper.** Small, and first. *Done 2026-11-08 and verified on Cody's machine against Maincloud; the second-machine check is still open.* | T done-when list |
| 7 ✅ | A (display, including the steady LIVE badge) + the B UI shell, then the B backend (stats, preview, import) | A and B done-when lists. *Done 2026-11-08 on `stable-forward`; the module changes (`my_project_stats`, `preview_project`, `preview_entities`) need `npm run db:publish` to `egress-dev` before `main` moves. Playhead-accurate readout rows are deferred.* |
| 8 ✅ | C: sharing and presence (permanent links, viewer joins, owner roles, presence chip). *Code done 2026-11-08; the desktop serving the site and runner is Cody's setup (SELF_HOSTING.md).* | C done-when list from a phone on cellular data |
| 9 ✅ | H: evacuation behavior v0.2 (attention span, patience, commitment, wait counted from people ahead) | H done-when list; PEOPLE_FLOW_MODEL updated. *Done: no mass switching (1–2 per tick vs 21–38), times equal or within ~2%.* |
| 10 ✅ | D: agent intent, grounded layout, placement tools, compliance | D done-when list, with Nemotron. *Done; combining several winners into one proposal is deferred.* |
| 11 ✅ | E: room labels (Nemotron + rules + user overrides) and escape plans | E done-when list. *Done; Nemotron labels the Courtyard as Office Suite / Conference Room / Main Corridor.* |
| 12 ✅ | F: slabs and materials, then floors and stairs (core, then sim, then UI), plus population painting | F done-when list. *Done 2026-11-08 except the multi-floor simulation, which moved to 12b (D91).* |
| 12b | F (rest): multi-floor evacuation (stairs link floor grids, people walk down, frame codec v2), upper-floor walkability from slabs, stair openings, upper-floor escape plans | The rest of the F done-when list |
| 13 ✅ | **K: collaborative modes** (§3 K): one shared live simulation per project, edits locked while it runs, presence by mode, shared analysis. Then **at least 3 example saves** that differ in size and layout. | K done-when list. *Done 2026-11-08 (D93); five example saves (D94).* |
| 14 | S: security review and fixes, then a **global naming check**: no "ExitCraft" left anywhere; it is Egress | S done-when list; `git grep -i exitcraft` is empty |
| 15 | Harden, final review and docs; publish the module to `egress-dev`; fast-forward `main` and tag **`STABLE-V2`** | Every V2 gate on the public site |
| ✅ | Final sprint: multi-floor evacuation, airflow with HVAC and a wind compass, furniture, furnished examples, Nemotron run grades; `main` fast-forwarded and tagged **`STABLE-V3`** (server update steps in LOCAL_SETUP.md) | docs/final-sprint/plan.md |
| 16+ | I: agentic evacuation mode; tag `STABLE-V4` | I done-when list |

- Pass 8 can start alongside 7 (it's mostly setup on the desktop). It needs B's JSON import before moving projects off Maincloud.
- Pass 9 comes before the agent work because agent proposals are only as good as the crowd model they measure.
- Within V3, the order of I and G is open (§8).

---

## 5. Testing

- `npm run test:backend` (core, sim, agent, client, runner) and the frontend `npm test`. Keep both green. *Known:* `real-plans.test.ts` from main `6780c69` fails one case; the frontend lane owns it.
- E2E against a local SpacetimeDB: `e2e:local`, `e2e:client`, `e2e:multiuser`. New flows (stats, preview, links, presence, rooms, floors) each add a step.
- Browser check of every changed UI at two sizes. Agent changes are also checked with Nemotron, not only the heuristic.
- Determinism: frame hashes per seed. A model change updates PEOPLE_FLOW_MODEL.md in the same commit.
- Behavior (H): exit switches and reversals per person on fixtures, with thresholds in tests. Agentic (I): runs replay identically from their decision tape, with no network.
- Security (S): the authorization matrix runs with every e2e from Pass 13 on. The client bundle is scanned for secrets in every build from Pass 6 on.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Home internet or power goes down during the demo | Keep Maincloud running until after the demo; the runner can serve both. A UPS is worth having. |
| Anonymous visitors spam projects or runs on `egress-dev` | Per-identity limits on projects, runs and agent jobs (S); Maincloud handles publishing rights |
| Cody's personal `SPACETIME_TOKEN` leaks (it controls his whole SpacetimeDB account) | Only in the publisher's own `.env`, never in the shared copy; move the database to a team account or organization before the public launch (D84) |
| Nemotron mislabels rooms | Rule fallback, confidence shown, user override |
| Multi-floor sim takes longer than planned | Ship floor surfaces and floors in the UI first; the sim allows down-only stairs and one stair per pair of floors to start |
| Smooth heatmap costs too much GPU | One bicubic sample per pixel at playback resolution; fall back to linear filtering |
| The shared `.env` leaks | Shared only through a password manager and without `SPACETIME_TOKEN`; rotation runbook (S) |
| Behavior v0.2 makes evacuations slower or less stable | Parameters from the literature; the v0.1 fixtures stay as a regression bar (within 10%) |
| Agentic mode costs or latency creep | A hard per-run call and token budget, cached situations, decision tapes for replays, deterministic fallback |

## 7. Human action items (Cody)

- [ ] Confirm where `dontrepeatyourself.dev` is registered. Add it to a free Cloudflare account and switch the nameservers ([SELF_HOSTING.md](docs/SELF_HOSTING.md) §1).
- [x] Fill in the root `.env` (NVIDIA key, service secret, `SPACETIME_DB_IDENTITY`, token). Verified 2026-11-08.
- [ ] Switch the main checkout (`C:\Workflows\Work\utd-hackathon`, still on the retired `implement-backend`) to `main` and copy the root `.env` there.
- [ ] Set the desktop to never sleep, use wired ethernet, and set Windows Update active hours around demos.
- [ ] Pick black or blueprint after the Pass 7 trial.
- [ ] Give your partner a copy of the `.env` **with `SPACETIME_TOKEN` blank**, through a password manager, and have them run the second-machine check (§3 T, Done when).

## 8. Open questions for Cody

1. **Background:** replace blueprint with black, or keep both as a setting?
2. **Escape plans:** is PNG enough, or is a printable PDF needed? Are secondary routes wanted on every plan?
3. **Stairs:** down-only for evacuation? (Assumed yes.) Any outdoor stairs or ramps?
4. **Upper floors:** should walls placed on floor 2 require a slab underneath, or warn?
5. ~~**Team token on Maincloud.**~~ Decided (D84): keep `egress-dev` on Cody's account for now; revisit a team account or organization before the public launch.

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
| D36 | 11-07 | **Live-mode restarts:** Live allows only distribution changes, which require a restart via a dedicated Stop. Cancellation lands within ~100 ms even while the runner paces ahead. |
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
| D55 | 11-08 | **UI v2 layout** (`docs/ARCHITECTURE.md` §8): full-window scene; compact mode switch at top center; presence and Layers at top right; a left pull tab that expands to a meta-action rail; an optional right context pane with a bottom action box; a bottom context toolbar attached to the bottom edge. No taglines; CAD-style tool buttons; modals allowed for Projects, Share and Import. |
| D56 | 11-08 | **Placeholder icons are Heroicons** (`@heroicons/react`), replacing lucide in the studio. |
| D57 | 11-08 | **Cross-hatching replaces dithering** for walls that hide the floor. Never in top-down views; evenly spaced in screen space; furniture stays opaque. |
| D58 | 11-08 | **No browser-local project storage.** Projects live only in SpacetimeDB (Maincloud by default). Browser storage keeps only the SpacetimeDB token that links the browser to its projects. Local save slots are removed. |
| D59 | 11-08 | **Collaboration model:** one permanent share link per project; joining gives viewer access; owners promote anyone; every owner sees the project in their list; people are identified by token; a presence count with hover-for-tokens sits at top right. Backend pieces are the next backend pass; until then Share issues a 14-day viewer invite. |
| D60 | 11-08 | **Parametric vs placeable:** only walls (later counters and similar runs) are parametric. Doors, windows and exits are wall-attached placeables; furniture is floor-placed. |
| D61 | 11-08 | **Agent suggestions:** several edits per proposal, highlighted in blue on the model with one short reason bubble each. The agent weighs compliance checks and measured safety. Compliance tooling and multi-edit batching are the next backend pass. |
| D62 | 11-08 | **Blender wall textures:** a manifest at `frontend/public/assets/walls/manifest.json` maps materials (later `finish` ids) to exported textures with world-scale UVs and a flat-colour fallback. |
| D63 | 11-08 | **Viewcube behaves like a CAD viewcube:** drag it to orbit; click faces, edges and corners for those views; it mirrors the camera. Edit still locks top-down. |
| D64 | 11-08 | **Plan rebuilt after `STABLE-V1`.** The plan (now `PLAN.md`) holds priorities, workstreams and decisions. The contracts (§3–§8, same numbers) moved to `docs/ARCHITECTURE.md`; the old plan is archived unchanged at `docs/history/PLAN-STABLE-V1.md`. |
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
| D76 | 11-08 | **Airflow layer:** a steady per-floor pressure solve under an assumed wind (any bearing), with HVAC ceiling vents as supply. Furniture blocks people, not air. |
| D77 | 11-08 | **Team access first (Pass 6):** one gitignored root `.env` (NVIDIA key, service secret, SpacetimeDB URL/DB and a team token) replaces the per-component env files. `npm run db` wraps the CLI with a repo-local config logged in by token, so nobody runs `spacetime login`. Only the derived public URI and database name reach the browser. Team identities only, never a personal token. |
| D78 | 11-08 | **Evacuation has two behavior modes.** Deterministic (v0.2) is the default and the basis for the agent's measurements; agentic is an opt-in mode on top of it. |
| D79 | 11-08 | **Deterministic v0.2 route choice.** Staggered per-person attention span `τ_i`; expected wait counted from people *ahead* who are heading to the same exit; waiting weighted by `κ_i`; commitment thresholds (absolute and relative), a no-switch zone near the exit and a cooldown; patience `P_i` that, once used up, lets a person walk to a farther exit. All draws are seeded. People know the full layout (per-exit Dijkstra fields). |
| D80 | 11-08 | **Agentic mode is a director, not a swarm.** One Nemotron call sets population behavior profiles; at most ~8 event-driven calls set group intents. There's a hard per-run budget, cached situations, deterministic fallback, and a recorded decision tape so replays need no calls. The engine still moves everyone. |
| D81 | 11-08 | **Security review before the public tag.** An authorization matrix e2e (every reducer and view × every role × own and foreign ids) plus checks on auth, links, abuse limits, LLM injection, web headers and upload routes, the edge and secrets. Recorded in `docs/SECURITY.md`. |
| D82 | 11-08 | **A steady LIVE badge.** Following live trails the edge by about one chunk so playback never stalls. The badge debounces: on within 1 s of the edge, off only when more than 4 s behind or after a scrub back. The thumb sits at the front of the timeline with a live-edge marker. |
| D83 | 11-08 | **Pass 6 as built.**<br>• `.env.example` at the repo root replaces the per-component examples.<br>• The runner loads `services/runner/.env` first, then the root `.env`; `SPACETIME_URL` derives the WebSocket URI.<br>• `scripts/spacetime.mjs` (`npm run db`, `db:publish`, `db:logs`, `db:sql`, `db:generate`) rebuilds `.spacetime/cli.toml` on each call, logs in by token, targets `SPACETIME_DB_IDENTITY` when set, finds the Windows CLI shim, and never prints the token. It was verified end to end on a throwaway local database.<br>• `next.config.ts` parses the root `.env` without loading it into `process.env` and inlines only the public URI and database name.<br>• `npm run build` runs a bundle secret scan, verified to fail on a planted value. |
| D84 | 11-08 | **The database stays on Cody's account.** `egress-dev` remains on Cody's personal Maincloud account; no new database. `SPACETIME_TOKEN` is his CLI token and lives only in the publisher's own `.env`; the shared copy leaves it blank, since the website, runner and visitors never need it. Before the public launch, revisit a team account or organization, which would mean a new database and a JSON move. |
| D85 | 11-08 | **Hosting splits:** the database stays on Maincloud; the home desktop runs only the Next.js site, the runner and the Cloudflare Tunnel. This drops the self-hosted SpacetimeDB, its publisher token and the edge lockdown of database routes from the plan. |
| D86 | 11-08 | **`Plan.md` renamed to `PLAN.md`.** References were repointed: architecture sections to `docs/ARCHITECTURE.md`, workstreams and decisions to `PLAN.md`, old passes to the archive. |
| D87 | 11-08 | **`STABLE-V1.1` and `stable-forward`.** `STABLE-V1.1` tags the verified team setup (`6593cd9`). Passes 7–13 run on `stable-forward`. CV floor-plan scanning is the partner's area; we only keep its seams stable (`buildingToDocument`, the importer entry points, `importProject`) and expect manual merges. |
| D88 | 11-08 | **Placeable rotation.** Floor-placed placeables (furniture) rotate about the vertical axis only (`rotationDeg`, yaw); wall-attached placeables follow their wall. The furniture contract adds this when the furniture pass lands. |
| D89 | 11-08 | **Collaboration is a V2 headline (Pass 13).** One shared live simulation per project that everyone in Simulate follows; edits are locked server-side while it runs and the presence chip shows the lock; presence includes each person's mode; analysis is shared. |
| D90 | 11-08 | **Security review moves to Pass 14, followed by a global naming check** (no "ExitCraft" left; the product is Egress). At least three varied example saves ship with Pass 13. |
| D91 | 11-08 | **Pass 12 as built.**<br>• `slab` and `stair` are JSON entity rows (no table change), with `createSlab`/`updateSlab`, `createFloor`/`updateFloor` and `createStair`/`updateStair`. Floors order by `level`; a new floor stacks on the top one; a height change restacks the floors above; deleting a floor lowers the ones above and removes stairs touching it; the last floor stays.<br>• A stair's top side comes from the drag direction and can be changed in its inspector (instead of an arrow with the R key).<br>• Upper-floor room hashes are salted with the floor id so stacked rooms keep their own labels.<br>• The module's save path only knew four entity kinds and silently dropped slabs and stairs; it now saves every kind, and e2e-client reads them back.<br>• The simulation compiles the lowest floor; the multi-floor model is Pass 12b. |
| D92 | 11-08 | **Population painting as built.** Painted distribution in the Simulate pane with a brush (More / Fewer / Reset, 0.5–8 m, linear falloff). Painting takes the left button and a live overlay shows relative start weights. Strokes stay in the studio until a run starts, and the run's scenario keeps them. |
| D93 | 11-08 | **Shared live simulation as built.** No `project_live` table: the lock is derived from `sim_runs` (a queued or running user run that progressed in the last 2 minutes), so a dead runner can never lock a project for good. It blocks `apply_edit`, `accept_proposal` and a second run (`PROJECT_LOCKED`), and both clients apply the same `locksEditing` rule locally. New: `presence_modes`, `set_mode`, `active_presence_modes`. The studio follows any new shared run, turns the presence chip red with a lock, and shows a Watch / Stop banner in Edit. |
| D94 | 11-08 | **Example saves** come from `content/examples/generate.mts` (real `applyEdit`): office floor, school wing, event hall and a two-storey clinic, plus the courtyard study. The saves page lists them with size and a suggested crowd and loads them on demand. A sim test checks each evacuates its suggested crowd. |
| D95 | 11-08 | **Exit reach.** Hovering an exit in Edit tints the area that walks to it, and Layers → Exit reach tints them all. Each exit's label estimates its people and clear time as people ÷ door flow, because floor area alone can flag the wrong door. Upper floors count toward the exit their stair leads to. It's an estimate: runs also move people away from long queues. |
| D96 | 11-08 | **Run inspection and occluders.** Hovering an exit during or after a run shows the heatmap of only the people who left through it, using the layer's field and statistic, or peak density in the Discrete view. Who used an exit comes from where each person stopped, so a live run covers those who have left so far. Replaces D57's cross-hatch with an ordered dither that is most transparent at the viewport centre and feathers to solid outwards. |
| D97 | 11-08 | **Scene colours.** Settings gain a Wall color (Original, Blue, White, Black, Red) and a Red background. Wall color applies to normal walls only: glass stays glass and reinforced stays gray. |
