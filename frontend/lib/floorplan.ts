import type { Opening, Point } from './building-editor';

export type Wall = { openings?: Opening[]; id: string; x1: number; z1: number; x2: number; z2: number; thickness: number };
export type FloorBounds = { minX: number; maxX: number; minZ: number; maxZ: number };
export type Floor = { id: string; points: Point[]; kind: 'drawn' | 'room' };
export type Building = { references?: { image: string; width: number; depth: number; x: number; z: number; rotation: number }[]; importInfo?: { calibrated: boolean; method: string; warnings: string[] }; referenceImage?: string; floors?: Floor[]; floorBounds?: FloorBounds | null; walls: Wall[]; width: number; depth: number; sourceWidth: number; sourceHeight: number };

// Extract long, dark horizontal and vertical runs, then consolidate adjacent
// scanlines into wall centerlines. Doorway gaps remain gaps in the geometry.
export function detectWalls(image: ImageData, buildingWidth: number, threshold: number, minLength: number): Building {
  const { width, height, data } = image;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    const a = data[i * 4 + 3] / 255;
    const luminance = (.2126 * data[i * 4] + .7152 * data[i * 4 + 1] + .0722 * data[i * 4 + 2]) * a + 255 * (1 - a);
    mask[i] = luminance < threshold ? 1 : 0;
  }
  type Run = { start: number; end: number; first: number; last: number };
  const walls: Wall[] = [];
  const scale = buildingWidth / width;
  for (const vertical of [false, true]) {
    const across = vertical ? width : height;
    const along = vertical ? height : width;
    const tracks: Run[] = [];
    const minimum = Math.max(10, Math.round(Math.max(width, height) * minLength / 100));
    for (let row = 0; row < across; row++) {
      let start = -1;
      let lastDark = -1;
      for (let col = 0; col <= along; col++) {
        const dark = col < along && mask[vertical ? col * width + row : row * width + col];
        if (dark) { if (start < 0) start = col; lastDark = col; }
        if (start >= 0 && ((!dark && col - lastDark > 2) || col === along)) {
          const end = lastDark + 1;
          if (end - start >= minimum) {
            const match = tracks.find(t => t.last === row - 1 && Math.abs(t.start - start) <= 7 && Math.abs(t.end - end) <= 7);
            if (match) { match.start = Math.min(match.start, start); match.end = Math.max(match.end, end); match.last = row; }
            else tracks.push({ start, end, first: row, last: row });
          }
          start = -1;
        }
      }
    }
    for (const t of tracks) {
      const thickness = t.last - t.first + 1;
      // Reject one-pixel annotation strokes and broad filled regions.
      if (thickness < 2 || thickness > Math.max(width, height) * .055) continue;
      const center = (t.first + t.last) / 2;
      const x1 = vertical ? center : t.start;
      const z1 = vertical ? t.start : center;
      const x2 = vertical ? center : t.end;
      const z2 = vertical ? t.end : center;
      walls.push({ id: `wall-${walls.length + 1}`, x1: x1 * scale - buildingWidth / 2, z1: z1 * scale - height * scale / 2, x2: x2 * scale - buildingWidth / 2, z2: z2 * scale - height * scale / 2, thickness: Math.max(.06, thickness * scale) });
    }
  }
  return { walls, width: buildingWidth, depth: height * scale, sourceWidth: width, sourceHeight: height };
}

export async function readFloorplan(source: string): Promise<HTMLCanvasElement> {
  const image = new Image();
  image.src = source;
  await image.decode();
  const ratio = Math.min(1, 1000 / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.width * ratio);
  canvas.height = Math.round(image.height * ratio);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Your browser could not read this image.');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// Use the actual wall mesh envelope rather than the uploaded image margins.
export function getWallBounds(walls: Wall[]) {
  if (!walls.length) return null;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const wall of walls) {
    const length = Math.hypot(wall.x2 - wall.x1, wall.z2 - wall.z1);
    if (!length) continue;
    const padX = Math.abs(wall.z2 - wall.z1) / length * wall.thickness / 2;
    const padZ = Math.abs(wall.x2 - wall.x1) / length * wall.thickness / 2;
    minX = Math.min(minX, wall.x1 - padX, wall.x2 - padX);
    maxX = Math.max(maxX, wall.x1 + padX, wall.x2 + padX);
    minZ = Math.min(minZ, wall.z1 - padZ, wall.z2 - padZ);
    maxZ = Math.max(maxZ, wall.z1 + padZ, wall.z2 + padZ);
  }
  return Number.isFinite(minX) ? { minX, maxX, minZ, maxZ } : null;
}


export function getFloorBounds(building: Building): FloorBounds | null {
  return building.floorBounds === undefined ? getWallBounds(building.walls) : building.floorBounds;
}
