# Egress UI references and agreed direction

Recorded 2026-11-07. Frontend implementation is deferred while the backend lane verifies Nemotron and Maincloud. This document complements [Plan.md](../Plan.md) and [PARTNER_SYNC.md](PARTNER_SYNC.md).

## Reference archive

The supplied references are preserved unchanged in [reference/gui](reference/gui/):

- [Original GUI notes](reference/gui/HackUTD%20GUI%20Notes.docx).
- [Working HTML/JavaScript prototype](reference/gui/files/index.html), with `app.js`, `bottombar.js`, `dropdown.js`, `grid.js`, `navbar.js`, and `popups.js` beside it.
- [Combined sketches](reference/gui/sketches/FINAL%20GUI%20sketches.png), [Design](reference/gui/sketches/Design%20mode%20GUI.png), [Simulate](reference/gui/sketches/Simulation%20mode%20GUI.png), [Analysis](reference/gui/sketches/Analysis%20mode%20GUI%20Suggestions%20Tab.png), and [startup popup](reference/gui/sketches/Starting%20Screen%20Popup%20GUI.png).

These files are design references, not instructions to execute or a replacement for the application. The notes contain historical implementation prompts. The prototype's random moving dots, sample chat, QR placeholder, and report placeholders do not demonstrate backend capabilities. Preserve the references; implement their layout through the existing React application and `@egress/client` later.

## Current product decisions

- **One 3D scene is the baseline in every mode.** All walls, furniture, and placeables are 3D. There is no separate 2D visual model, SVG asset set, or canvas editor to synchronize for top-down editing.
- **All editing happens top-down in that same scene.** Lock the camera to an orthographic plan view while editing, including future furniture placement. Leaving Edit transitions naturally to isometric, then enables freecam. Returning to Edit restores the top-down lock before enabling edits.
- **Freecam is for viewing.** A viewcube in the top-left reflects camera orientation and offers top/isometric/front/side presets. Keep it clear of the File menu. Proposed initial limits: camera stays above the active floor, no roll, and an orbit elevation of roughly 10–90 degrees; tune these in frontend implementation. A viewcube action cannot unlock editing at an angle.
- **Dither only occluding walls.** When a wall stands between the camera and the visible interior floor, fade it with a stable dither/cutaway treatment. Include that wall's trim and frames when they also obscure the floor. Keep a readable outline; do not fade unrelated walls or furniture/placeables. Glass remains visually glass and receives the occlusion treatment only when needed. Dithering changes rendering, never collision or simulation inputs.
- **Wall types remain `normal`, `reinforced`, and `glass`.** Their appearance differs; pedestrian collision is identical in v0.1.
- **Furniture/placeables must respect wall placement.** Later, validate their simple plan footprints against solid wall geometry and required opening clearance. Walls remain freely editable: do not introduce a reverse rule that prevents a wall edit because of furniture. If a wall edit overlaps a placeable, surface the placement conflict rather than silently moving or deleting it. Openings retain their existing host-wall and fit rules.
- Canonical plan coordinates and the simulation grid remain useful data beneath the 3D scene. They are not a second visual model. No camera state, dithering flag, GLB geometry, or asset loading state enters the shared edit contract.

## Layout and interaction reference

| Area | Preserve from supplied references | Backend mapping / deferred work |
|---|---|---|
| Navigation | Persistent sliding three-mode control at the top: Design / Simulate / Analysis. | Design maps to existing Edit; Simulate maps to Live. Display labels do not require a type rename. |
| File menu | Top-left, accessible in every mode; Upload/New and Save floor plan. | Upload/New returns to Design and opens the startup popup. Image recognition and QR upload remain deferred. PNG export is a visual export, not project persistence. |
| Startup | Design opens behind a dismissible optional-upload popup; drawing remains possible without upload. | Keep QR/upload affordances honest until a real upload workflow exists. |
| Workspace | Large unobstructed plan area behind stable controls. | Render the same 3D scene top-down for editing. Existing blueprint-blue floor, white lines, and dot-grid decisions remain recorded in Plan.md; the sketches' white/light-grey line grid is a reference variant to reconcile in frontend polish. |
| Design dock | Curved bottom dock with draw-line, draw-room/box, erase, and Clear Canvas; drag gestures for drawing/erasing/box sizing. | Use atomic `@egress/client.edit` commands and undo. The prototype's axis-aligned drawing restriction can guide the default gesture; do not remove diagonal geometry support from core. |
| Navigation hand | Persistent pan button at bottom-right; pan mode separate from editing. | Top-down pan/zoom during Edit; freecam only outside Edit. |
| Simulate dock | Run changes to Restart; setup tools lock while running. | Existing run/cancel/restart lifecycle, population distribution, pacing and replay. Keep Stop available and retain the LIVE/END scrubber and heatmap controls from Plan.md. |
| Fire | Reference shows a toggled cell icon before a run, locked during a run, cleared on return to Design. | Future scenario element only. v0.1 ignores `scenario.elements`; do not claim fire affects evacuation or add fire physics in this pass. |
| Analysis | Persistent panel while in Analysis, no close X; leaves when switching modes. Report / Suggestions buttons in the bottom dock, chat on the right with a usable input/send control. | Reports use measured run metrics; Suggestions use real proposals, ghost previews, and Accept/Reject. Chat uses the existing agent interface; never import the prototype's canned messages as results. |
| Export | White opaque PNG background, no fire icons. | Capture a clean top-down view of the same scene. Export must not mutate saved geometry or the active scenario. |

The reference's trails and dots are a rendering idea for actual replay frames, not a second movement model. Mode changes do not discard saved projects or authoritative runs. Restart/cancellation semantics continue to follow Plan.md.

## Frontend acceptance checklist for later

- Top-down and isometric/freecam views use identical entity IDs and scene objects; changing mode does not rebuild a second representation.
- Entering Edit prevents tilt/orbit and any angled editing; leaving Edit animates to isometric and enables bounded freecam.
- The viewcube reflects the camera, stays clear of File, and cannot navigate under the floor.
- Occluding walls reveal the floor with dithering from all allowed viewing directions; furniture stays opaque.
- Persistent navigation, File, bottom dock and hand match the reference layout. Analysis has both tabs and a working chat input with no close X.
- Export, fire placeholders, startup upload, and UI drawing restrictions follow the boundaries above without changing the backend contract.

For the Blender production and placement plan, see [3D_ASSET_PLAN.md](3D_ASSET_PLAN.md).
