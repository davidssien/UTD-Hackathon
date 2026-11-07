# ExitCraft Studio

A local floorplan-to-3D workspace built with Next.js, React, TypeScript, and Three.js.

## Run

Requires Node.js 22.18+ (Node.js 24 recommended).

```sh
npm install
npm run dev
```

Open http://localhost:3000. A sample residence is reconstructed automatically.

## Workspace

The app contains one full-screen viewport and two tabs: **3D model** and **Floor plan**.

Open **Floor plan** and select **Upload floor plan**, or drop a PNG, JPEG, or WebP image anywhere (up to 20 MB). The app reconstructs walls automatically. Switch to **3D model** to explore the result. The sample plan opens by default.

Uploads are processed locally and projects are held in memory until refresh. Reconstruction currently uses a default full-image width of 20 meters and wall height of 2.8 meters.

## Build tools

The bottom toolbar matches the three-part layout: **Build**, **Furniture**, and **Delete**. These tools work in both the 3D and floor plan views.

- **Build → Walls:** click a start and endpoint, or drag, to draw one wall. Each completed segment clears the draft; the next click starts a separate wall. Wall endpoints snap to existing vertices and a 0.5 m grid. Hold Shift for angled walls. Short, duplicate, and overlapping collinear walls are rejected.
- **Build → Draw floor:** choose two corners or drag to create a rectangular floor. Each floor finishes independently.
- **Build → Fill room:** click inside a closed room. The floor follows the surrounding wall outline, including angled and concave rooms. Open wall gaps must be closed; attached door/window openings do not break the room boundary.
- **Furniture → Door / Window:** choose an item, preview its placement, and click a wall. Openings attach to that wall, cut actual holes, and reject overlapping placements. Doors have open leaves; windows have frames and translucent panes.
- **Delete:** click a wall or opening. Deleting an opening fills its wall back in; deleting a wall also removes its attached openings.
- **Undo / Redo:** use the small toolbar buttons, Ctrl/⌘ Z, or Ctrl/⌘ Shift Z. History retains the most recent 50 edits. Undo/redo buttons stay hidden until an edit creates history, then appear together above the building toolbar.
- **Selection in 3D:** click a wall, Shift/Ctrl/⌘-click to add or remove walls, or drag a selection box. Selected walls are outlined in purple. Delete the selection using its trash button or Delete/Backspace; the whole action is undoable in one step.
- **Delete hover:** the label identifies the wall, its length, and its attached objects. Clicking a wall removes all attached doors/windows too.
- **Esc:** stop placement, clear selection, and return to navigation.

The floor plan view shows the original image as a faint tracing reference beneath editable vector geometry. Changes immediately appear in 3D. Editing never resets the camera.

## Camera controls

- The building's original footprint center is the camera origin. Right-drag or middle-drag orbits around it; scroll/pinch zooms toward or away from it. No WASD/free-camera movement is enabled.
- F frames the original building footprint. 1 selects front view; 7 selects top view.
- Touch gestures orbit and pinch to zoom when no build tool is active.

The custom cursor stays stationary during right-drag rotation. Browsers without pointer-lock support use a fixed visual cursor instead. Camera movement stops on release. Adding/deleting walls does not reset the camera or shift its origin.

## Floor footprint

The imported building's floor bounds are stored as independent model data at load time. Adding walls, including disconnected walls far outside the building, never grows or relocates the floor. Deleting walls never shrinks it. Undo and redo preserve the same floor geometry. The imported base floor has a rectangular footprint. Drawn floors and filled-room polygons are stored separately and do not resize that base floor. Custom floors can be deleted and restored with undo/redo.

## Recognition and limitations

The detector downsamples images to at most 1,000 pixels on their longest side, thresholds dark pixels, extracts horizontal and vertical runs, bridges scan gaps up to two pixels, and consolidates neighboring scanlines into vector wall segments. These are extruded into separate 3D meshes with inferred thickness and a common height. Gaps between runs remain openings; a rectangular floor slab fits the initial wall geometry bounds, excluding image margins, and then remains fixed during editing.

This is an initial image-processing reconstruction, not semantic architectural understanding. It works best with clean, axis-aligned dark walls on a light background. It does not recognize angled/curved walls, room polygons, windows, door types, furniture, text, roofs, or multiple floors. Thick annotation lines can be mistaken for walls. Perspective photographs should be rectified before import. PDF/DWG/DXF import is not supported; export them to an image first. Generated dimensions and topology should be checked against the source.

## Checks

```sh
npm test
npx tsc --noEmit
npm run build
```

The tests cover image recognition, calibration, floor bounds, snapping, wall validation, door/window constraints, actual opening geometry, deletion, and undo/redo.
