import * as THREE from 'three';
import { unprojectFrame } from './grid.js';

// Depth → Smoothing: each new depth frame is blended, cell by cell, with the
// previous smoothed frame. The previous frame is first carried into the new
// frame's view (its cells lifted into the room and projected again), so a
// moving camera doesn't smear depth across the image; only the depth
// estimate's own flicker is averaged away. A cell whose depth jumps by more
// than JUMP takes the new depth at once: something moved, or the view
// uncovered what was behind it, and averaging would leave a ghost. A cell
// the new frame has no depth for (motion parallax tracks only textured
// spots) keeps its carried depth for up to MAX_AGE frames, less sure each
// frame, so sparse estimates don't flicker.
//
// This is a plain exponential blend rather than a Kalman filter on sigma:
// the model's sigma is mostly its uncertain scale, which is the same error
// frame after frame, so as independent noise it would freeze the depth.

/**
 * How much of each new frame goes in at smoothing `amount` (0..1): all of
 * it at 0, MIN_ALPHA at 1, evenly in log between (0.5 is about a third).
 */
const MIN_ALPHA = 0.1;
export const smoothingAlpha = (amount) => MIN_ALPHA ** Math.min(Math.max(amount, 0), 1);
const JUMP = 0.15; // relative depth change that counts as a real change
const MAX_AGE = 6; // frames a cell's depth is carried without a new measurement
const AGE_SIGMA = 1.25; // and how much less sure it gets each frame

const _v = new THREE.Vector4();

/**
 * The previous frame's depth, sigma and age (frames since measured) as
 * seen from `next`'s view, on `next`'s grid (0: nothing there). Where two
 * cells land on one, the nearer wins; one-cell gaps (the view moved closer)
 * take a neighbour's.
 */
export function reproject(prev, next) {
  const { width, height } = next;
  const depth = new Float32Array(width * height);
  const sigma = new Float32Array(width * height);
  const age = new Uint8Array(width * height);
  const points = unprojectFrame(prev);
  for (let c = 0; c < prev.width * prev.height; c++) {
    if (!(prev.depth[c] > 0)) continue;
    _v.set(points[c * 3], points[c * 3 + 1], points[c * 3 + 2], 1).applyMatrix4(next.worldToCamera);
    const z = -_v.z;
    if (z <= 0) continue;
    _v.applyMatrix4(next.projection);
    const i = Math.floor(((_v.x / _v.w + 1) / 2) * width);
    const j = Math.floor(((1 - _v.y / _v.w) / 2) * height);
    if (i < 0 || i >= width || j < 0 || j >= height) continue;
    const k = j * width + i;
    if (depth[k] > 0 && depth[k] <= z) continue;
    depth[k] = z;
    sigma[k] = prev.sigma[c];
    age[k] = prev.age?.[c] ?? 0;
  }
  const filled = depth.slice();
  const filledSigma = sigma.slice();
  const filledAge = age.slice();
  for (let j = 0; j < height; j++)
    for (let i = 0; i < width; i++) {
      const k = j * width + i;
      if (depth[k] > 0) continue;
      let best = -1;
      for (const n of [i > 0 ? k - 1 : -1, i < width - 1 ? k + 1 : -1, j > 0 ? k - width : -1, j < height - 1 ? k + width : -1])
        if (n >= 0 && depth[n] > 0 && (best < 0 || depth[n] < depth[best])) best = n;
      if (best >= 0) {
        filled[k] = depth[best];
        filledSigma[k] = sigma[best];
        filledAge[k] = age[best];
      }
    }
  return { depth: filled, sigma: filledSigma, age: filledAge };
}

/** `next` blended with `prev` (the last smoothed frame) at smoothing `amount`, 0..1 (see smoothingAlpha). */
export function smoothFrame(prev, next, amount) {
  const alpha = smoothingAlpha(amount);
  if (!prev || alpha >= 1) return next;
  const past = reproject(prev, next);
  const depth = next.depth.slice();
  const sigma = next.sigma.slice();
  const age = new Uint8Array(depth.length);
  for (let k = 0; k < depth.length; k++) {
    const m = depth[k];
    const p = past.depth[k];
    if (!(m > 0) && p > 0 && past.age[k] < MAX_AGE) {
      depth[k] = p;
      sigma[k] = past.sigma[k] * AGE_SIGMA;
      age[k] = past.age[k] + 1;
    }
    if (!(m > 0 && p > 0) || Math.abs(m - p) > JUMP * Math.min(m, p)) continue;
    depth[k] = p + (m - p) * alpha;
    sigma[k] = past.sigma[k] + (sigma[k] - past.sigma[k]) * alpha;
  }
  return { ...next, depth, sigma, age };
}
