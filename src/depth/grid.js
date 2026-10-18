import * as THREE from 'three';

// Every depth source (ARCore, the ML model, the desktop test feed) ends up
// as a DepthFrame on one regular grid over the camera view that took it:
//
//   { source, width, height, depth, sigma, color, cameraToWorld,
//     projectionInverse, time }
//
// Cell (i, j) sits at normalized view coordinates u = (i + 0.5) / width
// (left to right), v = (j + 0.5) / height (top to bottom), index
// j * width + i. `depth` is metres along the view's -Z axis (0: unknown),
// `sigma` its one-sigma uncertainty in metres, `color` RGB bytes per cell
// (sRGB) or null. `cameraToWorld` and `projectionInverse` are the view's
// pose (in XROrigin space) and inverse projection when the image was
// taken, so a frame that arrives late still lands where it was seen.

/** Cells on the grid's long side. */
export const GRID_LONG = 128;

/** A grid of about GRID_LONG cells on the long side, with the view's aspect (width / height). */
export function gridSize(aspect) {
  return aspect >= 1
    ? { width: GRID_LONG, height: Math.max(2, Math.round(GRID_LONG / aspect)) }
    : { width: Math.max(2, Math.round(GRID_LONG * aspect)), height: GRID_LONG };
}

/**
 * Bilinear sample of a top-down `src` image (w x h floats) at normalized
 * (u, v). With `known` (the default), values <= 0 mean unknown and don't
 * bleed into known ones; without it every value counts (model output).
 */
export function sampleBilinear(src, w, h, u, v, known = true) {
  const x = Math.min(Math.max(u * w - 0.5, 0), w - 1);
  const y = Math.min(Math.max(v * h - 0.5, 0), h - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0;
  const fy = y - y0;
  const s00 = src[y0 * w + x0];
  const s10 = src[y0 * w + x1];
  const s01 = src[y1 * w + x0];
  const s11 = src[y1 * w + x1];
  const w00 = !known || s00 > 0 ? (1 - fx) * (1 - fy) : 0;
  const w10 = !known || s10 > 0 ? fx * (1 - fy) : 0;
  const w01 = !known || s01 > 0 ? (1 - fx) * fy : 0;
  const w11 = !known || s11 > 0 ? fx * fy : 0;
  const sum = w00 + w10 + w01 + w11;
  return sum > 0 ? (s00 * w00 + s10 * w10 + s01 * w01 + s11 * w11) / sum : 0;
}

/** RGB bytes per grid cell, from a top-down RGBA image (nearest pixel). */
export function gridColor(rgba, w, h, width, height) {
  const out = new Uint8Array(width * height * 3);
  for (let j = 0; j < height; j++) {
    const y = Math.min(h - 1, Math.floor(((j + 0.5) / height) * h));
    for (let i = 0; i < width; i++) {
      const x = Math.min(w - 1, Math.floor(((i + 0.5) / width) * w));
      const s = (y * w + x) * 4;
      const d = (j * width + i) * 3;
      out[d] = rgba[s];
      out[d + 1] = rgba[s + 1];
      out[d + 2] = rgba[s + 2];
    }
  }
  return out;
}

/**
 * Joint bilateral filter of the grid's depth, guided by its colour: each
 * cell averages its neighbours' depth, weighted by distance and by how alike
 * their colours are, so depth edges move onto colour edges (as the 2D-3D
 * converter's refine pass does on the GPU). Unknown cells stay unknown.
 */
export function bilateral(depth, color, width, height, radius = 2, colorSigma = 18) {
  const out = new Float32Array(depth.length);
  const inv2c = 1 / (2 * colorSigma * colorSigma);
  const inv2s = 1 / (2 * radius * radius);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const c = j * width + i;
      if (!(depth[c] > 0)) continue;
      let sum = 0;
      let wsum = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const y = j + dy;
        if (y < 0 || y >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const x = i + dx;
          if (x < 0 || x >= width) continue;
          const n = y * width + x;
          const d = depth[n];
          if (!(d > 0)) continue;
          const dr = color[n * 3] - color[c * 3];
          const dg = color[n * 3 + 1] - color[c * 3 + 1];
          const db = color[n * 3 + 2] - color[c * 3 + 2];
          const w = Math.exp(-(dx * dx + dy * dy) * inv2s - (dr * dr + dg * dg + db * db) * inv2c);
          sum += d * w;
          wsum += w;
        }
      }
      out[c] = sum / wsum;
    }
  }
  return out;
}

/**
 * How sharply depth changes at each cell, as the largest relative
 * difference to a 4-neighbour (0 flat, 1 doubling). Depth edges are where
 * every estimate is least sure, so sigma grows there.
 */
export function edgeStrength(depth, width, height) {
  const out = new Float32Array(depth.length);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const c = j * width + i;
      const d = depth[c];
      if (!(d > 0)) continue;
      let e = 0;
      if (i > 0 && depth[c - 1] > 0) e = Math.max(e, Math.abs(depth[c - 1] - d));
      if (i < width - 1 && depth[c + 1] > 0) e = Math.max(e, Math.abs(depth[c + 1] - d));
      if (j > 0 && depth[c - width] > 0) e = Math.max(e, Math.abs(depth[c - width] - d));
      if (j < height - 1 && depth[c + width] > 0) e = Math.max(e, Math.abs(depth[c + width] - d));
      out[c] = Math.min(e / d, 1);
    }
  }
  return out;
}

const _p = new THREE.Vector4();

/**
 * Per cell, the view-space direction through it scaled to z = -1, so a
 * point at depth d is d times it. Float32Array of width * height * 3.
 * `margin`: { x, y } cells of the grid that lie beyond each edge of the
 * view (an outpainted grid, see DepthPassthrough), 0 by default.
 */
export function cellRays(width, height, projectionInverse, margin = { x: 0, y: 0 }) {
  const rays = new Float32Array(width * height * 3);
  const innerW = width - 2 * margin.x;
  const innerH = height - 2 * margin.y;
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const u = (i - margin.x + 0.5) / innerW;
      const v = (j - margin.y + 0.5) / innerH;
      _p.set(u * 2 - 1, 1 - v * 2, 0.5, 1).applyMatrix4(projectionInverse);
      const k = (j * width + i) * 3;
      const z = -_p.z / _p.w;
      rays[k] = _p.x / _p.w / z;
      rays[k + 1] = _p.y / _p.w / z;
      rays[k + 2] = -1;
    }
  }
  return rays;
}

/**
 * A frame's cells in world (XROrigin) space: Float32Array of width * height * 3;
 * unknown cells are 0, 0, 0. An outpainted frame carries its `margin` (see cellRays).
 */
export function unprojectFrame(frame, out = new Float32Array(frame.width * frame.height * 3)) {
  const rays = cellRays(frame.width, frame.height, frame.projectionInverse, frame.margin);
  const e = frame.cameraToWorld.elements;
  for (let c = 0; c < frame.width * frame.height; c++) {
    const d = frame.depth[c];
    const k = c * 3;
    if (!(d > 0)) {
      out[k] = out[k + 1] = out[k + 2] = 0;
      continue;
    }
    const x = rays[k] * d;
    const y = rays[k + 1] * d;
    const z = -d;
    out[k] = e[0] * x + e[4] * y + e[8] * z + e[12];
    out[k + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    out[k + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  return out;
}
