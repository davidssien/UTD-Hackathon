# ExitCraft Studio

The root page on `implement-backend` is now the **Egress branch demo**, with one 3D scene, top-down-only Design, a viewcube, collapsible menu and local save slots. Read [the current demo guide](../docs/DEMO_UI.md) for the active controls and Maincloud connection. The descriptions below document retained editor/import modules from the merged frontend; image/QR import is not yet connected to the new canonical demo. The retained importer component is now inline rather than modal.

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

Run these commands from the `frontend/` directory.

```sh
npm test
npx tsc --noEmit
npm run build
```

The tests cover image recognition, calibration, floor bounds, snapping, wall validation, door/window constraints, actual opening geometry, deletion, and undo/redo.

## Sketch-to-House import

Choose **Import Floor Plan** from either view. Upload PNG/JPEG/WebP (10 MB max), or generate a QR code with **Use your phone**. The phone previews the photo before sending. Desktop polling stops when the image arrives.

Run `npm run dev -- --hostname 0.0.0.0` and use the same Wi-Fi network. QR links use a LAN address instead of localhost. With multiple adapters or an HTTPS tunnel, set `IMPORT_PUBLIC_ORIGIN` to the reachable origin before starting the server. Allow inbound traffic for the development port. LAN origins are explicitly allowed by Next.js configuration.

Review lines over the image before generating. Drag wall endpoints, trace missing walls, delete errors, and place native doors/windows. Toggle reference/wall/opening layers. Select a known wall and enter its length to calibrate scale. Translate/rotate the import onto the existing ground floor, or replace the building; confirmation is one undoable edit. Closed rooms become native floors. Autosave retains the building and reference, subject to browser storage capacity.

Recognition runs locally: adaptive contrast/thresholding, axis-aligned stroke extraction, endpoint/T-junction repair, and room reconstruction. It does not recognize door/window symbols, labels, dimension annotations, arbitrary angled strokes, or perspective. Correct these manually in review. All detections require review; scale remains estimated until calibrated. No AI service is called.

Upload sessions use private temporary files, separate random read/upload tokens, 15-minute expiry, bounded uploads, and decoded/re-encoded images. This backend targets a single Node server with writable temporary storage. Multi-instance/serverless deployment needs shared session/blob storage and deployment-level rate limiting. Expired files are removed on access/session creation; closing desktop pairing deletes the session. Physical phone cameras and real photographed drawings still need device testing. Multi-story import and automatic perspective/semantic recognition are not implemented.


## Vercel deployment

Set the Vercel project Root Directory to `frontend` and enable inclusion of
source files outside that directory. The checked-in `frontend/vercel.json`
installs the root workspace lockfile with `npm ci`, runs the frontend build,
and uses `.next` as its output. Remove conflicting dashboard command overrides.

Set `SPACETIME_URL` to the deployed HTTPS database host and `SPACETIME_DB` to
its published database name before building. These public connection settings
are compiled into the browser. The simulation runner and database are separate
services; deploying this frontend does not deploy either of them.

To reproduce the deployment from the repository root:

```sh
npm ci
npm run build --workspace=exitcraft-frontend
```

After changing settings, redeploy without the previous build cache. If a build
fails, capture the first error above the npm lifecycle summary, including the
lines preceding any “collapsed duplicate lines” notice.

Phone pairing uses the private SpacetimeDB `import_sessions` table and
`import_session` procedure. Publish the database module with `npm run db:publish`
before deploying the frontend. The existing SPACETIME_URL and SPACETIME_DB
settings select shared storage; no additional database or server secret is needed.
Sessions expire after 15 minutes; closing pairing deletes them. Expired rows are
removed on access or when another session is created.
