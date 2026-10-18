import { cellRays } from './grid.js';

// Depth without a model: two of the cheap estimates from WiFi Camera Link
// (and the 2D-3D converter's fallback), on the depth grid. Motion parallax,
// the third, is in parallax.js.

const MAX_DEPTH = 10;
// The floor is a fine guess for the floor and a poor one for anything
// standing on it, which gets the floor's depth behind it; sigma says so.
const GROUND_SIGMA = (z) => 0.05 + 0.08 * z;

/**
 * The 2D-3D converter's heuristic (WiFi Camera Link's Scene cues): lower in
 * the picture, brighter, more saturated and nearer the middle all read as
 * nearer, since subjects tend to be all four. Relative
 * (larger is nearer, 0..1), from the grid's colours (blurred over 5 x 5
 * cells first); the scale is fitted like a model's.
 */
export function heuristicDepth(color, width, height) {
  const values = new Float32Array(width * height);
  for (let j = 0; j < height; j++) {
    const vertical = j / (height - 1);
    for (let i = 0; i < width; i++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = Math.max(0, j - 2); y <= Math.min(height - 1, j + 2); y++)
        for (let x = Math.max(0, i - 2); x <= Math.min(width - 1, i + 2); x++) {
          const k = (y * width + x) * 3;
          r += color[k];
          g += color[k + 1];
          b += color[k + 2];
          n++;
        }
      r /= n * 255;
      g /= n * 255;
      b /= n * 255;
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      const saturation = Math.max(r, g, b) - Math.min(r, g, b);
      const dx = i / (width - 1) - 0.5;
      const dy = (vertical - 0.5) * 1.3;
      const t = Math.min(Math.hypot(dx, dy) / 0.75, 1);
      const centre = 1 - t * t * (3 - 2 * t);
      values[j * width + i] = Math.min(Math.max(0.5 * vertical + 0.2 * luma + 0.15 * saturation + 0.25 * centre - 0.05, 0), 1);
    }
  }
  return values;
}

/**
 * Ground plane: every cell's ray meets the floor (y = floorY in XROrigin
 * space; the local-floor reference space puts the floor at 0). Metric, from
 * the view's pose alone. Rays at or above the horizon have no depth.
 */
export function groundPlane(base, floorY = 0) {
  const { width, height } = base;
  const rays = cellRays(width, height, base.projectionInverse);
  const e = base.cameraToWorld.elements;
  const height0 = e[13] - floorY; // the camera's height above the floor
  const depth = new Float32Array(width * height);
  const sigma = new Float32Array(width * height);
  if (height0 <= 0.05) return { depth, sigma };
  for (let c = 0; c < width * height; c++) {
    const k = c * 3;
    // how fast the ray drops per metre of view depth (the world y of the rotated ray)
    const dy = e[1] * rays[k] + e[5] * rays[k + 1] + e[9] * rays[k + 2];
    if (dy >= -1e-3) continue;
    const z = height0 / -dy;
    if (z > MAX_DEPTH) continue;
    depth[c] = z;
    sigma[c] = GROUND_SIGMA(z);
  }
  return { depth, sigma };
}
