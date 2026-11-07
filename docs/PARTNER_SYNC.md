# Egress — Frontend / Backend Sync

**For:** davidssien (frontend, ExitCraft UI) · **From:** backend lane (Cody + Claude) · **Status:** to discuss · **Written:** 2026-11-07 17:30 CST

Context: [Plan.md](../Plan.md) is the build plan. We've renamed the product **Egress**.

The backend lives on `implement-backend`. Here's how the two branches stay in sync:
- After each of your commits, we merge `main` into our branch, so we're always testing against your newest UI.
- Our Pass 0 (contracts plus a mock client) lands on `main` at about **19:30**.
- The full merge happens after our Pass 2, at about **03:30**.

Item 6 in the table below explains how the UI will read and write project data.

---

## 1. What we're asking the UI for

1. **Mode tabs at the top: Edit / Live / Analysis.** The toolbar switches with the mode. Your current tools fit under Edit.
2. **Edit toolbar:**
   - **Pen:** click-to-click wall chain; Esc ends it.
   - **Box:** drag out 4 walls with shared corners.
   - **Erase:** drag a line; every wall it crosses is deleted.
   - **Door / Exit / Window:** click a wall.
   - **Undo / Redo.**
3. **Live toolbar:**
   - Population count, seed and pace (1× / 2× / 4×).
   - Transport: `« 10` · `⏯` · `» 10`, jumping 10 simulated seconds.
   - A **scrubber along the bottom** from 0 to the **LIVE** edge, which is the latest tick the server has sent. A `LIVE` badge jumps back to the edge, and turns into `END` when the run finishes.
   - Heatmap selector: **Current / Average / Peak**. After a run completes the default is Average, because the final frame is an empty building.
   - A metrics panel showing evacuation time, evacuated / remaining / unreachable, max queue, and throughput per exit.
4. **Analysis mode:**
   - A **chat box replaces the toolbar**.
   - Each agent tool call shows as a step card.
   - Suggested edits appear **immediately as ghost entities** (tinted or dashed), each with a "why" bubble. Accept or Reject applies to the whole proposal.
   - A before/after metrics card.
5. **Rendering for the simulation:**
   - Actors are dots, interpolated at 60 fps from 10 Hz frames.
   - The heatmap is a grid of 0.25 m cells.
   - Your call: plan view only, 3D, or both? See §4.

---

## 2. Model differences to settle

Your latest commit already **welds endpoints within 0.3 m**, **resizes connected walls together**, and **miters corners**. In practice that's shared vertices; our proposal just makes them explicit.

| # | Topic | ExitCraft today | Backend proposal | Why |
|---|---|---|---|---|
| 1 | Coordinates | `{x, z}`, with z pointing down in the plan | `{x, y}` in meters, **+y = north** | Matches the spec and the simulation grid. Adapters: plan `(x, y)` → three.js `(x, 0, -y)`, and SVG flips y. |
| 2 | Walls | Free segments `{x1, z1, x2, z2}`; endpoints welded by distance | `Vertex` entities, with walls referencing `startVertexId` / `endVertexId`. T-junctions and crossings split walls automatically. | Moving a corner moves every wall attached to it with no distance matching, and room detection and corner computation read the graph directly. |
| 3 | Openings | Nested in `wall.openings[]`; door or window | Separate `Opening` entities with `wallId`. Kinds are `door`, `window` and **`exit`**; doors have an open/closed `state`. | The simulation needs explicit exits. The agent can propose a single opening change, and each opening gets its own saved row. |
| 4 | Floors | Base floor rectangle, drawn floors, filled-room slabs | `Floor` holds level metadata only (elevation, ceiling height). The interior is **derived** from the rooms the walls enclose. | The simulation needs one unambiguous inside. **Question:** keep your slabs as cosmetic surfaces, or drop them? |
| 5 | Corners and wall meshes | Box solids with overlap culling, plus your new miter logic | `@egress/core.wallPolygons(doc)` returns one 2D polygon per wall piece, with miter, hub, cap and bevel corners and the openings cut out. You extrude it for 3D and fill it in SVG. | The picture and the collision geometry come from the same polygons. |
| 6 | Editor state | Local reducer with undo/redo; `crypto.randomUUID()`; `localStorage` autosave (`exitcraft-project-v1`) | SpacetimeDB is the source of truth, accessed through `@egress/client`.<br>• `edit(commands)` applies the edit instantly on your screen, then the server confirms it.<br>• Undo and redo are built in.<br>• New IDs come from the request ID. | Two-browser sync and saved projects come for free. **Question:** keep autosave as an offline fallback? |
| 7 | Edit commands | `wall`, `floor`, `fill-floor`, `resize-wall`, `opening`, `delete`, … | `createWallChain`, `createBox`, `eraseByLine`, `moveVertex`, `updateWall`, `createOpening`, `updateOpening`, `deleteEntities`, `applyPatch` | One shared command set means the server checks exactly what the client applied. |
| 8 | Snapping | 0.5 m grid | **0.25 m** (toggleable) | Matches the simulation's 0.25 m cells. |
| 9 | Image import | Detects walls from a PNG/JPEG | **Keep it**, as a Pass 4 stretch goal. The detector's output becomes one `applyPatch`. | It's great for modelling the venue, but not a primary goal. |
| 10 | Code layout | All logic in `lib/`, npm at the root | Your app stays at the root. Pure logic moves into `packages/core`, and `lib/` re-exports it so your imports keep working. | Lets the SpacetimeDB module and the runner reuse the same code. |
| 11 | Name | ExitCraft Studio | **Egress** | |

---

## 3. Using `@egress/client`

```ts
import { createMockClient } from '@egress/client';          // available from Pass 0 (~19:30)
import { useEgress } from '@egress/client/react';

const client = createMockClient();                          // later: createSpacetimeClient({ uri, db })
const doc = useEgress(client.document);                     // walls, openings, wallPolygons, rooms, diagnostics
await client.edit([{ kind: 'createBox', floorId, min, max, thicknessM: 0.2, heightM: 2.8, material: 'normal' }]);

const playback = client.playback(runId);
const { tick, liveTick, playing, complete } = useEgress(playback.state);
const { xy, flags } = playback.actorsAt(tick / 10);         // Float32Array of x,y pairs, in meters
const heat = playback.field('people.congestion', 'timeAverage');
```

The mock and the real client have the same interface. Code against the mock and the switch to SpacetimeDB is one line. Plan.md §8 lists the full interface.

---

## 4. Open questions for you

1. Where do the Live and Analysis visuals render: the 2D plan, 3D, or both?
2. Should your floor slabs stay as cosmetic surfaces, or be dropped?
3. Is the 0.25 m snap OK?
4. Should `localStorage` autosave stay as an offline fallback?
5. Which web host: Vercel?
6. Anything in the model above that breaks something you've already built?
