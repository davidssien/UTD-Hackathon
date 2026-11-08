/**
 * Navigation fields (Plan.md §6 "Compile" step 5): one distance-to-exit field
 * per exit, by Dijkstra over navigable cells. 8-connected, no corner cutting,
 * with a mild penalty next to walls so paths keep off them.
 */
import type { GridDefinition } from '@egress/core';

export interface Navigation {
  /** fields[e][cell] = path distance (m) to exit e; Infinity if unreachable. */
  fields: Float32Array[];
  /** 1 where any 8-neighbour is not navigable. */
  nearWall: Uint8Array;
  /** Unit direction of steepest descent toward exit e at (x, y), or null if unreachable. */
  direction(exit: number, x: number, y: number): { x: number; y: number } | null;
  /** Path distance to exit e from (x, y); Infinity if unreachable. */
  distanceAt(exit: number, x: number, y: number): number;
  cellAt(x: number, y: number): number;
}

/** Paths closer than this to a wall edge cost more, so people are routed through the middle of openings. */
const CLEARANCE_M = 0.35;
const CLEARANCE_PENALTY = 6;
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];

/** blockedEdges[i] bit k set ⇒ stepping from cell i in direction k crosses a wall. */
export function buildNavigation(grid: GridDefinition, navigable: Uint8Array, exitSeeds: number[][], blockedEdges: Uint8Array, clearance: Float32Array): Navigation {
  const { width, height, cellSizeM: cell, origin } = grid;
  const n = width * height;
  const nearWall = new Uint8Array(n);
  for (let cy = 0; cy < height; cy++) for (let cx = 0; cx < width; cx++) {
    const i = cy * width + cx;
    if (!navigable[i]) continue;
    for (let k = 0; k < 8; k++) {
      const x = cx + DX[k], y = cy + DY[k];
      if (x < 0 || y < 0 || x >= width || y >= height || !navigable[y * width + x] || (blockedEdges[i] & (1 << k))) { nearWall[i] = 1; break; }
    }
  }

  const fields = exitSeeds.map(seeds => dijkstra(grid, navigable, clearance, blockedEdges, seeds));

  const cellAt = (x: number, y: number) => {
    const cx = Math.floor((x - origin.x) / cell), cy = Math.floor((y - origin.y) / cell);
    return cx < 0 || cy < 0 || cx >= width || cy >= height ? -1 : cy * width + cx;
  };

  const passableStep = (cx: number, cy: number, k: number) => {
    const x = cx + DX[k], y = cy + DY[k];
    if (x < 0 || y < 0 || x >= width || y >= height || !navigable[y * width + x]) return -1;
    if (blockedEdges[cy * width + cx] & (1 << k)) return -1;
    if (k >= 4 && (!navigable[cy * width + x] || !navigable[y * width + cx])) return -1; // no corner cutting
    return y * width + x;
  };

  return {
    fields,
    nearWall,
    cellAt,
    distanceAt(exit, x, y) {
      const i = cellAt(x, y);
      return i < 0 ? Infinity : fields[exit][i];
    },
    direction(exit, x, y) {
      const field = fields[exit];
      const i = cellAt(x, y);
      if (i < 0) return null;
      const cx = i % width, cy = (i - cx) / width;
      const here = field[i];
      let ax = 0, ay = 0, best = Infinity, bx = 0, by = 0;
      for (let k = 0; k < 8; k++) {
        const j = passableStep(cx, cy, k);
        if (j < 0) continue;
        const d = field[j];
        if (d < best) { best = d; bx = DX[k]; by = DY[k]; }
        if (Number.isFinite(here) && d < here) {
          const len = k >= 4 ? Math.SQRT2 : 1;
          const w = (here - d) / len;
          ax += (DX[k] / len) * w;
          ay += (DY[k] / len) * w;
        }
      }
      if (!Number.isFinite(here)) {
        // Standing on a non-navigable cell (pushed against a wall): head for the best neighbour.
        if (!Number.isFinite(best)) return null;
        const len = Math.hypot(bx, by);
        return { x: bx / len, y: by / len };
      }
      const len = Math.hypot(ax, ay);
      if (len < 1e-9) return null;
      return { x: ax / len, y: ay / len };
    },
  };
}

function dijkstra(grid: GridDefinition, navigable: Uint8Array, clearance: Float32Array, blockedEdges: Uint8Array, seeds: number[]): Float32Array {
  const { width, height, cellSizeM: cell } = grid;
  // Float64 while searching: comparing float64 keys with float32-rounded distances would skip nodes.
  const dist = new Float64Array(width * height).fill(Infinity);
  const heap = new MinHeap();
  for (const s of seeds) {
    if (!navigable[s]) continue;
    dist[s] = 0;
    heap.push(s, 0);
  }
  while (heap.size) {
    const [i, d] = heap.pop();
    if (d > dist[i]) continue;
    const cx = i % width, cy = (i - cx) / width;
    for (let k = 0; k < 8; k++) {
      const x = cx + DX[k], y = cy + DY[k];
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const j = y * width + x;
      if (!navigable[j] || (blockedEdges[i] & (1 << k))) continue;
      if (k >= 4 && (!navigable[cy * width + x] || !navigable[y * width + cx])) continue;
      const tight = Math.max(0, (CLEARANCE_M - clearance[j]) / CLEARANCE_M);
      const step = (k >= 4 ? Math.SQRT2 : 1) * cell * (1 + CLEARANCE_PENALTY * tight);
      const nd = d + step;
      if (nd < dist[j]) {
        dist[j] = nd;
        heap.push(j, nd);
      }
    }
  }
  return Float32Array.from(dist);
}

/** Binary min-heap of (cell, priority). Ties break on cell index for determinism. */
class MinHeap {
  private cells: number[] = [];
  private keys: number[] = [];
  get size() {
    return this.cells.length;
  }
  push(cell: number, key: number) {
    this.cells.push(cell);
    this.keys.push(key);
    let i = this.cells.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(p, i)) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.cells[0], this.keys[0]];
    const lastCell = this.cells.pop()!, lastKey = this.keys.pop()!;
    if (this.cells.length) {
      this.cells[0] = lastCell;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.cells.length && this.less(l, m)) m = l;
        if (r < this.cells.length && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private less(a: number, b: number) {
    return this.keys[a] < this.keys[b] || (this.keys[a] === this.keys[b] && this.cells[a] < this.cells[b]);
  }
  private swap(a: number, b: number) {
    [this.cells[a], this.cells[b]] = [this.cells[b], this.cells[a]];
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
  }
}
