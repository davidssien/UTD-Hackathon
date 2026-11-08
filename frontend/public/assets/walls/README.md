# Wall textures from Blender

`manifest.json` tells the 3D scene how each wall looks. Edit it; no code change is needed.

```json
{
  "version": 1,
  "materials": {
    "normal": { "color": "#ffffff", "baseColor": "/assets/walls/plaster/basecolor.png", "normal": "/assets/walls/plaster/normal.png", "roughnessMap": "/assets/walls/plaster/roughness.png", "repeatM": 2 }
  },
  "finishes": {
    "brick-red": { "color": "#ffffff", "baseColor": "/assets/walls/brick/basecolor.png", "repeatM": 1.2 }
  }
}
```

- **Materials** are the three wall types: `normal`, `reinforced` and `glass`. They are what the simulation and the wall-type menu know about.
- **Finishes** are optional per-side looks. A wall's `finish.left` / `finish.right` id picks one; otherwise the material look is used.
- `color` multiplies the base-colour texture, so use `#ffffff` with a texture. `opacity` below 1 makes the wall translucent (glass).
- **Floors** are the three floor surface finishes: `wood`, `basic` and `tile` (`"floors": { "wood": { "color": "#ffffff", "baseColor": "/assets/walls/oak/basecolor.png", "repeatM": 2 } }`). Without a `baseColor`, wood and tile get a drawn plank or tile pattern tinted by `color`.
- `repeatM` is how many metres one texture tile covers. Wall and floor UVs are in metres, so the texture keeps its scale on any wall length and height.

## Exporting from Blender

1. Make a seamless, tileable material. Bake procedural nodes to images (Cycles: Bake → Diffuse colour only, Normal, Roughness).
2. Bake onto a 1 × 1 plane that represents `repeatM` metres of wall, at 1024 or 2048 px.
3. Save PNG (or JPG for base colour) into `public/assets/walls/<name>/`: `basecolor.png` (sRGB), `normal.png` (OpenGL, non-colour) and `roughness.png` (non-colour).
4. Add the paths to `manifest.json` and reload the page.

A missing or unreadable file falls back to the flat colour. GLB wall modules (trims, frames) are a later step; see `docs/3D_ASSET_PLAN.md`.
