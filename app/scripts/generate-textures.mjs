// Writes the tileable background textures to assets/textures.
// Run: npm --workspace app run generate-textures
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const SIZE = 256;
const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "textures");

// mulberry32: a fixed seed gives the same PNG bytes on each run.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Value noise on a lattice that wraps at the image edge, so the tile has no seams.
function tileableNoise(random, cells) {
  const grid = Array.from({ length: cells * cells }, () => random());
  const at = (x, y) => grid[(y % cells) * cells + (x % cells)];
  const smooth = (t) => t * t * (3 - 2 * t);
  return (px, py) => {
    const fx = (px / SIZE) * cells;
    const fy = (py / SIZE) * cells;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = smooth(fx - x0);
    const ty = smooth(fy - y0);
    const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
    const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
    return top * (1 - ty) + bottom * ty;
  };
}

function writeTexture(name, seed, pixel) {
  const random = rng(seed);
  const coarse = tileableNoise(random, 8);
  const medium = tileableNoise(random, 32);
  const png = new PNG({ width: SIZE, height: SIZE });
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const n = 0.5 * coarse(x, y) + 0.3 * medium(x, y) + 0.2 * random();
      const [r, g, b] = pixel(n, random);
      const i = (y * SIZE + x) * 4;
      png.data[i] = clamp(r);
      png.data[i + 1] = clamp(g);
      png.data[i + 2] = clamp(b);
      png.data[i + 3] = 255;
    }
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${name}.png`), PNG.sync.write(png));
}

function clamp(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

// Paper: warm beige #ece2d1 with low-contrast brown noise.
writeTexture("paper", 1, (n) => {
  const d = (n - 0.5) * 18;
  return [0xec + d, 0xe2 + d * 0.9, 0xd1 + d * 0.7];
});

// Chalk: #2a2a2a with faint white noise and a few white specks.
writeTexture("chalk", 2, (n, random) => {
  const speck = random() < 0.01 ? 18 : 0;
  const d = (n - 0.5) * 10 + speck;
  return [0x2a + d, 0x2a + d, 0x2a + d];
});
