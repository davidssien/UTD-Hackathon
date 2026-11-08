/**
 * Wall looks for the 3D scene (Plan.md §8 "Blender wall textures", D62).
 *
 * `public/assets/walls/manifest.json` maps each wall material, and later each
 * per-side `finish` id, to textures exported from Blender. Every texture is
 * optional: anything missing falls back to the flat material colour, so the
 * scene never waits on art. Extruded wall geometry has world-scale UVs (one UV
 * unit = one metre), so a texture repeats every `repeatM` metres on any wall.
 * Physics never reads any of this.
 */
import * as THREE from 'three';
import type { Wall, WallMaterial } from '@egress/core';

export interface WallLook {
  /** Flat colour, also multiplied into the base-colour texture. */
  color: string;
  opacity: number;
  roughness: number;
  /** Texture URLs relative to the site root, e.g. `/assets/walls/plaster/basecolor.png`. */
  baseColor?: string;
  normal?: string;
  roughnessMap?: string;
  /** Metres covered by one texture tile. */
  repeatM: number;
}

export interface WallManifest {
  version: 1;
  materials?: Partial<Record<WallMaterial, Partial<WallLook>>>;
  finishes?: Record<string, Partial<WallLook>>;
}

export const MANIFEST_URL = '/assets/walls/manifest.json';

export const DEFAULT_LOOKS: Record<WallMaterial, WallLook> = {
  normal: { color: '#f2f5f8', opacity: 1, roughness: 0.85, repeatM: 1 },
  reinforced: { color: '#b4c2d1', opacity: 1, roughness: 0.75, repeatM: 1 },
  glass: { color: '#bfe8ff', opacity: 0.35, roughness: 0.1, repeatM: 1 },
};

export class WallLibrary {
  private looks: Record<WallMaterial, WallLook> = { ...DEFAULT_LOOKS };
  private finishes: Record<string, WallLook> = {};
  private readonly textures = new Map<string, THREE.Texture>();
  private readonly loader = new THREE.TextureLoader();

  /** Loads the manifest; resolves to the defaults when it is missing or invalid. */
  static async load(url = MANIFEST_URL): Promise<WallLibrary> {
    const library = new WallLibrary();
    try {
      const response = await fetch(url, { cache: 'no-cache' });
      if (response.ok) library.apply((await response.json()) as WallManifest);
    } catch { /* defaults */ }
    return library;
  }

  apply(manifest: WallManifest): void {
    if (manifest?.version !== 1) return;
    for (const key of Object.keys(DEFAULT_LOOKS) as WallMaterial[]) {
      this.looks[key] = { ...DEFAULT_LOOKS[key], ...manifest.materials?.[key] };
    }
    for (const [id, look] of Object.entries(manifest.finishes ?? {})) {
      this.finishes[id] = { ...DEFAULT_LOOKS.normal, ...look };
    }
  }

  look(wall: Pick<Wall, 'material' | 'finish'>): WallLook {
    const finish = wall.finish?.left ?? wall.finish?.right;
    return (finish && this.finishes[finish]) || this.looks[wall.material];
  }

  /** A new material per mesh (so each wall can be hatched or highlighted on its own); textures are shared. */
  material(wall: Pick<Wall, 'material' | 'finish'>): THREE.MeshStandardMaterial {
    const look = this.look(wall);
    const material = new THREE.MeshStandardMaterial({
      color: look.color,
      roughness: look.roughness,
      transparent: look.opacity < 1,
      opacity: look.opacity,
      depthWrite: look.opacity >= 1,
    });
    if (look.baseColor) material.map = this.texture(look.baseColor, look.repeatM, true);
    if (look.normal) material.normalMap = this.texture(look.normal, look.repeatM, false);
    if (look.roughnessMap) material.roughnessMap = this.texture(look.roughnessMap, look.repeatM, false);
    return material;
  }

  private texture(url: string, repeatM: number, color: boolean): THREE.Texture {
    const key = `${url}|${repeatM}`;
    let texture = this.textures.get(key);
    if (!texture) {
      texture = this.loader.load(url);
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(1 / repeatM, 1 / repeatM);
      texture.anisotropy = 4;
      if (color) texture.colorSpace = THREE.SRGBColorSpace;
      this.textures.set(key, texture);
    }
    return texture;
  }

  dispose(): void {
    for (const t of this.textures.values()) t.dispose();
    this.textures.clear();
  }
}
