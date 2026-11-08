# Egress branch demo

Implemented on `implement-backend` after merging current `origin/main` at `1c1cd88`. Keep these changes on this branch; no push or website publication was requested.

## Open the demo

From the repository root, run `npm install` and `npm run dev`, then open [the demo](http://localhost:3000/).

- `/` uses durable browser-local save slots and the existing shared client/simulation implementation. A small example opens on first use; later visits restore the selected save. Layouts persist; local simulation results and undo history are session-only.
- `/?backend=maincloud` uses the real `@egress/client` connection to `egress-dev` and the running Maincloud worker. Projects, edits, runs and results live in SpacetimeDB. NVIDIA remains runner-only.
- `/?backend=local` uses the real local database/worker. `/dev?backend=local` remains the plain backend harness.
- The Save slots panel also offers these storage choices. Browser-local slots belong to this browser/origin, so use the same `localhost` address. Clearing site data removes local saves; Export plan provides a JSON copy.

## Controls and implemented behavior

- **One 3D scene.** Design locks the existing meshes to an orthographic overhead camera. Simulate and Analysis transition to isometric, then allow orbit/pan/zoom. No second 2D editor is used by the demo.
- **Viewcube.** The cube reflects the camera and its top/north/south/east/west faces select views. Top/Iso/Front and Frame controls are also available. Side views are disabled in Design. Camera elevation stays above the floor; the floor cannot be viewed from underneath.
- **Walls and rooms.** Select Walls and click two points or drag a segment. Hold Shift for angles; otherwise the gesture is axis-aligned. Room creates a wall box. Snapping is 0.25 m. All edits use the existing deterministic core and client commands.
- **Existing asset types.** Normal, reinforced and glass wall styles; doors, windows and exits with the existing procedural 3D frame/pane/leaf treatment. Pick a type in the left menu, then place it in the top-down scene. Selecting a wall reveals its material inspector.
- **Erase and history.** Click an opening/wall or drag through walls to erase; Undo/Redo use the shared client. Esc cancels an unfinished gesture. F frames the current layout.
- **Collapsible left menu.** Its handle opens/closes it. Every bottom-toolbar action collapses it again. Save slots opens an inline switcher with the existing plans and a named **+ Create new** action. No modal or blocking popup is used, including by the retained sketch importer component.
- **Persistence.** Browser-local save slots automatically record the active document and selection of save slot. Multiple plans survive refresh independently. Invalid/unreadable old saves are preserved rather than overwritten; storage failures show an error. Maincloud projects already provide separate server saves.
- **Viewing.** Walls that intercept camera-to-interior-floor samples use alpha-hashed dithering; their frames/trim follow the wall. Furniture is not part of the fade set. This uses Three.js [alpha-hashed transparency](https://threejs.org/docs/pages/Material.html#alphaHash), rather than changing collision or deleting geometry.
- **Simulation/report.** Population, Run/Stop, playback controls and a basic measured report use the existing backend. A new run automatically plays at 4×. Analysis Suggestions connects to the existing agent/proposal APIs. This demo does not yet include every control from `/dev`, such as the heatmap selector, population painting or full replay scrubber.

The current frontend's top mode control, switching bottom taskbar, palette, and side-menu patterns and the [recorded UI references](UI_REFERENCE.md) guide the layout. The supplied sketches remain reference artifacts; their startup modal is superseded by the user's no-modal direction. The current sketch/QR importer and server routes were retained by the merge; connecting imported legacy layouts to the canonical document is deferred.

## What the simplest demo still needs from the backend

**No new backend contract is required for drawing a wall layout, changing among the three wall types, placing doors/windows/exits, viewing the result in 3D, or using multiple saved projects.** Those operations are implemented already and the demo now uses them.

The main backend gap for the next asset pass is **furniture/placeable instances**: a prefab reference, floor/position/rotation, edit commands, and footprint/clearance validation against walls and egress openings. `furniture: []` remains reserved. Do not add that contract merely for decorative art.

Blender `.glb` loading, module fitting, materials and render budgets are frontend/asset work; none are prerequisites for displaying the existing procedural meshes. No Blender GLB library is bundled by this demo. See [3D_ASSET_PLAN.md](3D_ASSET_PLAN.md) before that pass. Floor surfaces are derived from enclosed rooms; custom free-standing slabs, multi-floor navigation, fire and airflow remain outside this simple demo.

## Verification

- All **41 frontend tests** passed, including new tests for independent local slots, refresh recovery and preserving unreadable saves.
- Frontend typecheck, targeted lint and the production build passed, including the final camera/toolbar/playback refinements.
- Browser: created a second save, drew a room, switched saves, refreshed and recovered the selected plan. Placed a real exit in the same scene. Checked top-down camera lock, isometric transition, viewcube presets and wall-only dithering.
- Maincloud through this UI: a glass room changed the layout from 10 to 14 walls; confirmation returned and undo restored 10. A 50-person run completed in **47.4 s**, with **50 evacuated / 0 remaining**, and the report reached Analysis. The worker logged 24 replay chunks and the same 50/50 result.

Only repository commits are made for this demo. Nothing is pushed back to `main` or published as a website.
