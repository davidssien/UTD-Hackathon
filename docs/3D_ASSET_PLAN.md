# Egress 3D asset plan

Recorded 2026-11-07 for later frontend/asset work. The current backend pass does not add furniture entities, reducers, asset tables, or new physics.

## One scene and one geometry source

The application always displays a 3D scene. Edit changes only the camera and enabled interactions: the same meshes are viewed from directly above, then transition to isometric/freecam on exit. Do not build separate top-down models.

The existing wall graph, dimensions, and openings stay authoritative. `deriveLayout(doc).walls` supplies the plan outlines for the 3D structure and pedestrian collision. Blender assets decorate or assemble onto that structure; importing a GLB must not redefine room boundaries or create invisible collision differences. Map plan `(x, y)` to three.js `(x, elevationM, -y)`.

## Blender delivery

Use `.blend` files as editable sources and `.glb` as runtime assets. Agree on these conventions before producing a library:

- Author in meters, apply scale/rotation, use a consistent origin, and check dimensions after export. For furniture use the floor-contact point at footprint center; for wall modules use the centerline at the floor and a documented start endpoint.
- After glTF export, a straight wall module runs along local +X, height is +Y, and thickness is Z. Verify this once with a 1 m calibration asset rather than adding per-asset axis fixes. Blender's export performs the up-axis conversion.
- Model complete geometry: both wall faces, top, end caps, and any visible underside; outward normals and sensible UVs. Furniture must have a back and sides, not just a good front silhouette. No camera-facing cards as substitutes for solid models.
- Use named mesh/material slots for wall faces, glass, frame, trim, and caps so the viewer can apply finishes and wall-only occlusion consistently. Bake unsupported procedural shader effects into textures; use glTF-compatible PBR materials. Inspect actual GLB output in the app.
- Use double-sided materials for intentionally thin surfaces, such as a single glass pane, when required. Do not use double-sided rendering to hide missing faces or broken normals in a solid wall. Blender's Backface Culling setting maps inversely to glTF's DoubleSided flag. See the [Blender glTF manual](https://docs.blender.org/manual/en/dev/addons/scene_gltf2.html).
- Keep a lightweight mesh and small shared texture set for the first assets. Preview at actual plan scale and low camera elevations before increasing detail. Exact polygon/texture budgets should follow measurement in the frontend scene.

## Walls without seams or distorted detail

Start with one visual family each for `normal`, `reinforced`, and `glass`; map the existing `Wall.material` value to a frontend asset/material registry. The three materials remain equally blocking to pedestrians. Reuse the existing per-side `finish` IDs for surface appearance when needed.

Recommended first implementation:

1. Build the actual wall volume from the shared wall outlines and opening dimensions. Preserve the graph's miter/bevel/T/X junctions, wall height/thickness, opening gaps, window sills, and lintels in the visible 3D geometry.
2. Supply Blender-authored repeatable straight panels, surface materials, trim, caps, and opening-frame modules. Separate an unadorned stretchable region from fixed-size decorative details. Tile detail along variable lengths; do not stretch a complete furnished panel indiscriminately.
3. Fit the modules to the procedural structure, trimming at joins and openings. Keep junction closures procedural initially, since arbitrary wall angles and T/X intersections cannot be covered by a small set of rigid corner assets. Do not introduce angle restrictions merely to fit the art.
4. Group each wall's render meshes under its entity ID. Apply dithering to all occluding components of that wall together, including imported frames/trim, while preserving doorway visibility and readable silhouettes. The dither should be stable as the camera moves and should not leave an opaque shadow blocking the revealed floor.

A complete Blender wall kit is possible, but must demonstrate variable lengths, different heights/thicknesses, all opening kinds, and arbitrary graph junctions before replacing the procedural body. Avoid runtime mesh booleans for every edit in the initial implementation. This is a production recommendation, not a new shared schema.

## Occlusion and freecam

Begin with a wall-only camera-to-interior occlusion test and a stable screen-space dither for the affected walls. Smooth the transition and restore walls when they stop blocking the floor. Do not simply fade every wall facing the camera; that can hide distant non-occluding walls. Test the glass material with the same effect to avoid compounded transparency artifacts. Furniture and independent placeables never enter the wall fade set.

Initial camera limits are a frontend tuning proposal: no roll, stay above the active floor, and keep orbit elevation roughly 10–90 degrees. Entering Edit locks straight overhead. Exiting Edit animates to isometric before freecam resumes. The top-left viewcube mirrors orientation and respects these limits. Camera, occlusion and asset selection are client-only.

## Furniture and placeables later

Prepare a small registry entry per asset with a stable ID, GLB location, real dimensions, pivot/orientation, simple rectangle/circle/convex plan footprint, and any placement clearance. Repeated items should share geometry/materials where practical.

When the furniture pass begins, propose the smallest entity/command addition needed for a placed instance: prefab reference, floor, plan position and rotation. Decide scaling and revision handling then. Do not expand `EgressDocument`, `EgressClient`, or SpacetimeDB now just to reserve speculative fields; `furniture: []` stays unchanged in this pass.

Placement validation should transform the simple footprint and test against authoritative solid wall polygons and opening/egress clearance. This applies to placing/moving/rotating furniture and other independent placeables. Wall drawing/moving is not constrained by furniture; diagnose resulting invalid placements without silently relocating objects. Doors/windows/exits continue to attach to their host walls using existing commands. The simulation must eventually consume the same simple furniture footprints before obstacle behavior is advertised; decorative triangle meshes do not become physics inputs.

## First asset review

Review one normal wall, one reinforced wall, one glass wall, and one furniture item before scaling the library. Check front/back/top/oblique views; 45-degree and acute joins; T/X intersections; the shortest allowed wall; resized walls; doors/exits/windows; shared per-side finishes; glass/frame dithering; and furniture beside a wall. Confirm the camera never reaches below the active floor, and that the top-down edit view is the same scene used in freecam.
