/**
 * Wall looks for the 3D scene (docs/ARCHITECTURE.md §8 "Blender wall textures", D62).
 *
 * `public/assets/walls/manifest.json` maps each wall material, and later each
 * per-side `finish` id, to textures exported from Blender. Every texture is
 * optional: anything missing falls back to the flat material colour, so the
 * scene never waits on art. Extruded wall geometry has world-scale UVs (one UV
 * unit = one metre), so a texture repeats every `repeatM` metres on any wall.
 * Physics never reads any of this.
 */
import * as THREE from 'three';
import type { SlabMaterial, Wall, WallMaterial } from '@egress/core';

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
  /** Floor surfaces (D74). Without a texture, wood and tile get a drawn pattern. */
  floors?: Partial<Record<SlabMaterial, Partial<WallLook>>>;
}

export const MANIFEST_URL = '/assets/walls/manifest.json';

export const DEFAULT_LOOKS: Record<WallMaterial, WallLook> = {
  normal: { color: '#f2f5f8', opacity: 1, roughness: 0.85, repeatM: 1 },
  reinforced: { color: '#b4c2d1', opacity: 1, roughness: 0.75, repeatM: 1 },
  glass: { color: '#bfe8ff', opacity: 0.35, roughness: 0.1, repeatM: 1 },
};

export const DEFAULT_FLOOR_LOOKS: Record<SlabMaterial, WallLook> = {
  wood: { color: '#b5875a', opacity: 1, roughness: 0.7, repeatM: 2 },
  basic: { color: '#d6dbe1', opacity: 1, roughness: 0.9, repeatM: 1 },
  tile: { color: '#e4e8ec', opacity: 1, roughness: 0.4, repeatM: 0.6 },
};

/** A drawn stand-in texture so floors read as wood or tile before any Blender art exists. */
function patternTexture(kind: SlabMaterial): THREE.Texture | null {
  if (kind === 'basic' || typeof document === 'undefined') return null;
  const size = 256, canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d'); if (!g) return null;
  if (kind === 'wood') {
    // Planks a quarter of the tile wide, staggered, with slightly different tones.
    const tones = ['#ffffff', '#f1ece6', '#e7e0d8', '#f7f3ee'];
    for (let row = 0; row < 8; row++) {
      for (let k = -1; k < 2; k++) {
        const x = (k + (row % 2) * 0.5) * size;
        g.fillStyle = tones[(row * 3 + k + 4) % tones.length];
        g.fillRect(x, row * size / 8, size, size / 8);
        g.fillStyle = 'rgba(60,40,20,0.35)'; g.fillRect(x, row * size / 8, 2, size / 8);
      }
      g.fillStyle = 'rgba(60,40,20,0.3)'; g.fillRect(0, row * size / 8, size, 1.5);
    }
  } else {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, size, size);
    g.fillStyle = 'rgba(80,90,100,0.45)';
    g.fillRect(0, 0, size, 3); g.fillRect(0, 0, 3, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class WallLibrary {
  private looks: Record<WallMaterial, WallLook> = { ...DEFAULT_LOOKS };
  private floorLooks: Record<SlabMaterial, WallLook> = { ...DEFAULT_FLOOR_LOOKS };
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
    for (const key of Object.keys(DEFAULT_FLOOR_LOOKS) as SlabMaterial[]) {
      this.floorLooks[key] = { ...DEFAULT_FLOOR_LOOKS[key], ...manifest.floors?.[key] };
    }
  }

  floorLook(material: SlabMaterial): WallLook {
    return this.floorLooks[material];
  }

  /** A floor surface material. Shape geometry UVs are in metres, so `repeatM` applies as on walls. */
  floorMaterial(material: SlabMaterial): THREE.MeshStandardMaterial {
    const look = this.floorLooks[material];
    const m = new THREE.MeshStandardMaterial({ color: look.color, roughness: look.roughness, transparent: look.opacity < 1, opacity: look.opacity });
    if (look.baseColor) m.map = this.texture(look.baseColor, look.repeatM, true);
    else {
      const key = `pattern:${material}`;
      let t = this.textures.get(key);
      if (!t) {
        const made = patternTexture(material);
        if (made) { made.wrapS = made.wrapT = THREE.RepeatWrapping; made.repeat.set(1 / look.repeatM, 1 / look.repeatM); made.anisotropy = 4; this.textures.set(key, made); t = made; }
      }
      if (t) m.map = t;
    }
    if (look.normal) m.normalMap = this.texture(look.normal, look.repeatM, false);
    if (look.roughnessMap) m.roughnessMap = this.texture(look.roughnessMap, look.repeatM, false);
    return m;
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
