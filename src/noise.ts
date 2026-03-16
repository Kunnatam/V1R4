/**
 * Simple 1D value noise — cheap, smooth, organic.
 * Good enough for procedural animation without importing a library.
 */

// Permutation table (seeded pseudo-random)
const P = new Uint8Array(512);
(function seed() {
  const base = new Uint8Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;
  // Fisher-Yates shuffle with fixed seed for determinism
  let s = 42;
  for (let i = 255; i > 0; i--) {
    s = (s * 16807 + 0) % 2147483647;
    const j = s % (i + 1);
    [base[i], base[j]] = [base[j], base[i]];
  }
  P.set(base);
  P.set(base, 256);
})();

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function grad1d(hash: number, x: number): number {
  return (hash & 1) === 0 ? x : -x;
}

/** 1D Perlin-style noise, returns [-1, 1] */
export function noise1d(x: number): number {
  const xi = Math.floor(x) & 255;
  const xf = x - Math.floor(x);
  const u = fade(xf);

  const a = grad1d(P[xi], xf);
  const b = grad1d(P[xi + 1], xf - 1);

  return a + u * (b - a);
}

/**
 * Layered noise (fractal Brownian motion).
 * Combines multiple octaves for richer, more natural movement.
 */
export function fbm(x: number, octaves: number = 3, lacunarity: number = 2.0, gain: number = 0.5): number {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  let maxAmplitude = 0;

  for (let i = 0; i < octaves; i++) {
    value += noise1d(x * frequency) * amplitude;
    maxAmplitude += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }

  return value / maxAmplitude;
}
