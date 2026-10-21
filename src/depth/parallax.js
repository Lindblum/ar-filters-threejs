import { cellRays } from './grid.js';

// Motion parallax: as the phone moves, near things slide across the picture
// further than far ones. WiFi Camera Link reads depth straight off that
// slide (optical flow, minus the picture's overall pan), since it can't know
// how its camera moved. Here ARCore says exactly how the camera moved, so
// the slide becomes real triangulation, the way ARCore's own depth works:
// points on a grid are tracked back to an earlier frame (sparse pyramidal
// Lucas-Kanade), and each pair of rays, from where the camera was then and
// where it is now, meets at the point's metric depth. Its sigma comes from
// the angle between the rays: the wider, the surer.
//
// The earlier frame is the latest with at least GOOD_BASELINE of camera
// travel, so depth stays sure without tracking across too much change.
// Standing still gives no parallax and no depth; smoothing carries the last
// depth for a few frames. It runs in a worker (ParallaxWorker, below), off the render thread.

const FLOW_LONG = 160; // tracking image's long side, pixels
const LEVELS = 3; // pyramid levels: 160, 80, 40
const RADIUS = 4; // the tracked patch is 9 x 9
const ITERATIONS = 8;
const STRIDE = 2; // track every other grid cell each way, and fill between
const KEYFRAMES = 15; // about 1.5 s of frames to look back over
const MIN_BASELINE = 0.02; // metres of camera travel below which there's no parallax worth using
const GOOD_BASELINE = 0.06;
const MIN_PARALLAX = (0.3 * Math.PI) / 180; // narrower ray pairs can't fix depth
const MAX_ERROR = 0.07; // mean |grey difference| of a tracked patch; worse is a mismatch
const MIN_TEXTURE = 2e-4; // a patch's smaller gradient eigenvalue per pixel; flatter can't be tracked
const TRACK_SIGMA_PX = 0.75; // how well a patch is located, in tracking pixels
const MAX_DEPTH = 10;

/** A grey image of about FLOW_LONG on its long side, from a top-down RGBA one (box filtered). */
function greyImage(rgba, w, h) {
  const k = Math.max(1, Math.round(Math.max(w, h) / FLOW_LONG));
  const gw = Math.floor(w / k);
  const gh = Math.floor(h / k);
  const data = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++)
    for (let x = 0; x < gw; x++) {
      let sum = 0;
      for (let dy = 0; dy < k; dy++)
        for (let dx = 0; dx < k; dx++) {
          const s = ((y * k + dy) * w + x * k + dx) * 4;
          sum += 0.299 * rgba[s] + 0.587 * rgba[s + 1] + 0.114 * rgba[s + 2];
        }
      data[y * gw + x] = sum / (k * k * 255);
    }
  return { data, w: gw, h: gh };
}

/** The image and its half and quarter sizes (2 x 2 averages). */
function pyramid(image) {
  const levels = [image];
  for (let l = 1; l < LEVELS; l++) {
    const src = levels[l - 1];
    const w = Math.max(1, src.w >> 1);
    const h = Math.max(1, src.h >> 1);
    const data = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const s = y * 2 * src.w + x * 2;
        data[y * w + x] = (src.data[s] + src.data[s + 1] + src.data[s + src.w] + src.data[s + src.w + 1]) / 4;
      }
    levels.push({ data, w, h });
  }
  return levels;
}

function sample(img, x, y) {
  const cx = Math.min(Math.max(x, 0), img.w - 1.001);
  const cy = Math.min(Math.max(y, 0), img.h - 1.001);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const fx = cx - x0;
  const fy = cy - y0;
  const i = y0 * img.w + x0;
  const d = img.data;
  return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + img.w] * (1 - fx) + d[i + img.w + 1] * fx) * fy;
}

const N = (2 * RADIUS + 1) ** 2;
const _t = new Float32Array(N);
const _gx = new Float32Array(N);
const _gy = new Float32Array(N);

/**
 * Where the patch at (x0, y0) in `from` (level-0 pixels) is in `to`,
 * starting from the guess (gx, gy): inverse compositional Lucas-Kanade,
 * coarse to fine. Returns [x, y] or null if the patch is too flat to
 * track, ran off the image, or doesn't match.
 */
export function track(from, to, x0, y0, gx, gy) {
  let px = (gx - x0) / 2 ** (LEVELS - 1);
  let py = (gy - y0) / 2 ** (LEVELS - 1);
  let minEigen = 0;
  for (let l = LEVELS - 1; l >= 0; l--) {
    const T = from[l];
    const I = to[l];
    const tx = x0 / 2 ** l;
    const ty = y0 / 2 ** l;
    let a = 0;
    let b = 0;
    let c = 0;
    let n = 0;
    for (let v = -RADIUS; v <= RADIUS; v++)
      for (let u = -RADIUS; u <= RADIUS; u++, n++) {
        _t[n] = sample(T, tx + u, ty + v);
        _gx[n] = (sample(T, tx + u + 1, ty + v) - sample(T, tx + u - 1, ty + v)) / 2;
        _gy[n] = (sample(T, tx + u, ty + v + 1) - sample(T, tx + u, ty + v - 1)) / 2;
        a += _gx[n] * _gx[n];
        b += _gx[n] * _gy[n];
        c += _gy[n] * _gy[n];
      }
    const det = a * c - b * b;
    if (det < 1e-12) return null;
    if (l === 0) minEigen = ((a + c) / 2 - Math.sqrt(((a - c) / 2) ** 2 + b * b)) / N;
    for (let it = 0; it < ITERATIONS; it++) {
      let bx = 0;
      let by = 0;
      n = 0;
      for (let v = -RADIUS; v <= RADIUS; v++)
        for (let u = -RADIUS; u <= RADIUS; u++, n++) {
          const e = sample(I, tx + u + px, ty + v + py) - _t[n];
          bx += _gx[n] * e;
          by += _gy[n] * e;
        }
      const dx = (c * bx - b * by) / det;
      const dy = (a * by - b * bx) / det;
      px -= dx;
      py -= dy;
      if (dx * dx + dy * dy < 4e-4) break;
    }
    if (l > 0) {
      px *= 2;
      py *= 2;
    }
  }
  if (minEigen < MIN_TEXTURE) return null;
  const x = x0 + px;
  const y = y0 + py;
  const I = to[0];
  if (x < RADIUS || y < RADIUS || x > I.w - 1 - RADIUS || y > I.h - 1 - RADIUS) return null;
  let error = 0;
  let n = 0;
  for (let v = -RADIUS; v <= RADIUS; v++)
    for (let u = -RADIUS; u <= RADIUS; u++, n++) error += Math.abs(sample(I, x + u, y + v) - _t[n]);
  return error / N > MAX_ERROR ? null : [x, y];
}

/** Fills a grid from values at every STRIDE-th cell each way (0: unknown), bilinearly between known ones. */
function fillFromStride(sparse, width, height) {
  const out = new Float32Array(width * height);
  for (let j = 0; j < height; j++)
    for (let i = 0; i < width; i++) {
      const i0 = i - (i % STRIDE);
      const j0 = j - (j % STRIDE);
      const fx = (i - i0) / STRIDE;
      const fy = (j - j0) / STRIDE;
      let sum = 0;
      let wsum = 0;
      for (const [x, y, w] of [
        [i0, j0, (1 - fx) * (1 - fy)],
        [i0 + STRIDE, j0, fx * (1 - fy)],
        [i0, j0 + STRIDE, (1 - fx) * fy],
        [i0 + STRIDE, j0 + STRIDE, fx * fy],
      ]) {
        if (x >= width || y >= height || w <= 0) continue;
        const s = sparse[y * width + x];
        if (!(s > 0)) continue;
        sum += s * w;
        wsum += w;
      }
      if (wsum > 0) out[j * width + i] = sum / wsum;
    }
  return out;
}

/** World-space direction (not normalized) of view direction (x, y, z) under a camera-to-world matrix. */
function rotate(e, x, y, z) {
  return [e[0] * x + e[4] * y + e[8] * z, e[1] * x + e[5] * y + e[9] * z, e[2] * x + e[6] * y + e[10] * z];
}

export class MotionParallax {
  keyframes = [];

  reset() {
    this.keyframes = [];
  }

  /**
   * Metric depth for a captured frame. `base`: the frame's grid and view
   * (see grid.js). Returns { depth, sigma, baseline, tracked }.
   */
  estimate(image, base) {
    const pyr = pyramid(greyImage(image.rgba, image.width, image.height));
    const frame = { pyr, ...base };
    const result = this.triangulate(frame);
    this.keyframes.push(frame);
    if (this.keyframes.length > KEYFRAMES) this.keyframes.shift();
    return result;
  }

  /** Metric depth by triangulating against the latest frame far enough away. */
  triangulate(frame) {
    const { width, height } = frame;
    const depth = new Float32Array(width * height);
    const sigma = new Float32Array(width * height);
    const e1 = frame.cameraToWorld.elements;
    const c1 = [e1[12], e1[13], e1[14]];
    let key = null;
    let baseline = 0;
    for (let i = this.keyframes.length - 1; i >= 0; i--) {
      const e = this.keyframes[i].cameraToWorld.elements;
      const b = Math.hypot(e[12] - c1[0], e[13] - c1[1], e[14] - c1[2]);
      if (b > baseline) {
        baseline = b;
        key = this.keyframes[i];
      }
      if (b >= GOOD_BASELINE) break;
    }
    if (!key || baseline < MIN_BASELINE) return { depth, sigma, baseline, tracked: 0 };

    const img = frame.pyr[0];
    const rays = cellRays(width, height, frame.projectionInverse);
    const e2 = key.cameraToWorld.elements;
    const c2 = [e2[12], e2[13], e2[14]];
    const toKey = key.worldToCamera.elements;
    const proj = key.projection.elements;
    const keyInv = key.projectionInverse.elements;
    const focalPx = (frame.projection.elements[0] * img.w) / 2;
    const sigmaAngle = TRACK_SIGMA_PX / focalPx;
    const sparseDepth = new Float32Array(width * height);
    const sparseSigma = new Float32Array(width * height);
    let tried = 0;
    let tracked = 0;
    for (let j = 0; j < height; j += STRIDE)
      for (let i = 0; i < width; i += STRIDE) {
        const c = j * width + i;
        tried++;
        const d1 = rotate(e1, rays[c * 3], rays[c * 3 + 1], -1);
        // the guess: where this direction lies in the earlier view if the point were infinitely far
        const vx = toKey[0] * d1[0] + toKey[4] * d1[1] + toKey[8] * d1[2];
        const vy = toKey[1] * d1[0] + toKey[5] * d1[1] + toKey[9] * d1[2];
        const vz = toKey[2] * d1[0] + toKey[6] * d1[1] + toKey[10] * d1[2];
        if (vz >= -1e-6) continue;
        const ndcX = (proj[0] * vx + proj[4] * vy + proj[8] * vz) / -vz;
        const ndcY = (proj[1] * vx + proj[5] * vy + proj[9] * vz) / -vz;
        const x0 = ((i + 0.5) / width) * img.w - 0.5;
        const y0 = ((j + 0.5) / height) * img.h - 0.5;
        const hit = track(frame.pyr, key.pyr, x0, y0, ((ndcX + 1) / 2) * img.w - 0.5, ((1 - ndcY) / 2) * img.h - 0.5);
        if (!hit) continue;
        // the matched point's ray in the earlier view, into the room
        const nx = ((hit[0] + 0.5) / img.w) * 2 - 1;
        const ny = 1 - ((hit[1] + 0.5) / img.h) * 2;
        const pw = keyInv[3] * nx + keyInv[7] * ny + keyInv[11] * 0.5 + keyInv[15];
        const px = (keyInv[0] * nx + keyInv[4] * ny + keyInv[8] * 0.5 + keyInv[12]) / pw;
        const py = (keyInv[1] * nx + keyInv[5] * ny + keyInv[9] * 0.5 + keyInv[13]) / pw;
        const pz = (keyInv[2] * nx + keyInv[6] * ny + keyInv[10] * 0.5 + keyInv[14]) / pw;
        const d2 = rotate(e2, px, py, pz);
        // the closest points of the two rays
        const w0 = [c1[0] - c2[0], c1[1] - c2[1], c1[2] - c2[2]];
        const a = d1[0] * d1[0] + d1[1] * d1[1] + d1[2] * d1[2];
        const b = d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2];
        const cc = d2[0] * d2[0] + d2[1] * d2[1] + d2[2] * d2[2];
        const d = d1[0] * w0[0] + d1[1] * w0[1] + d1[2] * w0[2];
        const e = d2[0] * w0[0] + d2[1] * w0[1] + d2[2] * w0[2];
        const den = a * cc - b * b;
        const angle = Math.acos(Math.min(1, b / Math.sqrt(a * cc)));
        if (den < 1e-12 || angle < MIN_PARALLAX) continue;
        const s = (b * e - cc * d) / den; // along d1, whose view z is -1: s is the view depth
        const t = (a * e - b * d) / den;
        if (s < 0.1 || t <= 0 || s > MAX_DEPTH) continue;
        const sz = (s * sigmaAngle) / Math.sin(angle);
        if (sz > 0.4 * s) continue;
        sparseDepth[c] = s;
        sparseSigma[c] = sz;
        tracked++;
      }
    const filledDepth = fillFromStride(sparseDepth, width, height);
    const filledSigma = fillFromStride(sparseSigma, width, height);
    for (let k = 0; k < depth.length; k++)
      if (filledDepth[k] > 0) {
        depth[k] = filledDepth[k];
        sigma[k] = filledSigma[k];
      }
    return { depth, sigma, baseline, tracked: tried ? tracked / tried : 0 };
  }
}

const MATRICES = ['cameraToWorld', 'worldToCamera', 'projection', 'projectionInverse'];

/** Motion parallax in its worker (parallax.worker.js), one frame at a time, with MotionParallax's methods. */
export class ParallaxWorker {
  worker = null;
  nextId = 1;
  pending = new Map();

  start() {
    this.worker = new Worker(new URL('./parallax.worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      this.pending.get(e.data.id)?.(e.data.result);
      this.pending.delete(e.data.id);
    };
  }

  reset() {
    this.worker?.postMessage({ type: 'reset' });
    this.pending.forEach((resolve) => resolve(null));
    this.pending.clear();
  }

  /** Resolves with MotionParallax.estimate's result (or null if reset meanwhile). The image's buffer is handed over. */
  estimate(image, base) {
    if (!this.worker) this.start();
    const id = this.nextId++;
    const plain = { ...base };
    for (const key of MATRICES) plain[key] = base[key].toArray();
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage({ type: 'frame', id, image, base: plain }, [image.rgba.buffer]);
    });
  }
}
