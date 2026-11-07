/**
 * Seeded PRNG (sfc32). The only source of randomness allowed in the
 * simulation and anything that must be reproducible from a seed.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** Standard normal via Box–Muller. */
  normal(mean: number, stdDev: number): number;
  /** Integer in [0, n). */
  int(n: number): number;
}

export function createRng(seed: number): Rng {
  let a = 0x9e3779b9, b = 0x243f6a88, c = 0xb7e15162, d = seed >>> 0;
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const r = (t + d) | 0;
    c = (c + r) | 0;
    return (r >>> 0) / 4294967296;
  };
  for (let i = 0; i < 15; i++) next(); // warm up so nearby seeds diverge
  return {
    next,
    range: (min, max) => min + (max - min) * next(),
    normal: (mean, stdDev) => {
      const u = Math.max(next(), 1e-12), v = next();
      return mean + stdDev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    int: n => Math.floor(next() * n),
  };
}
