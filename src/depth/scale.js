// The depth model's output is relative inverse depth: larger is nearer, but
// in no unit and with an unknown offset. Inverse depth is close to affine in
// it, so 1/z = a·m + b, fitted against anything metric: ARCore's depth, hit
// tests on surfaces, or, with neither, an assumed range.

const MIN_PAIRS = 12;
const HUBER = 1.345; // in units of the residuals' robust spread
const ITERATIONS = 4;
const NEAR = 0.25; // metres: the assumed scale's range when nothing is metric
const FAR = 5;
export const MAX_DEPTH = 10;

/**
 * Robust (Huber, iteratively reweighted) least squares fit of
 * 1/z = a·m + b over pairs of model values `m` and metric depths `z`.
 * Returns { a, b, spread (the residuals' robust sigma in inverse depth),
 * error (median |z - fitted z|, metres), n } or null if there are too few
 * pairs or the fit runs backwards (nearer reading as farther).
 */
export function fitInverseDepth(m, z) {
  const n = m.length;
  if (n < MIN_PAIRS) return null;
  const target = Float64Array.from(z, (d) => 1 / d);
  const w = new Float64Array(n).fill(1);
  const r = new Float64Array(n);
  let a = 0;
  let b = 0;
  let spread = 0;
  for (let it = 0; it < ITERATIONS; it++) {
    let sw = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
      sw += w[i];
      sx += w[i] * m[i];
      sy += w[i] * target[i];
      sxx += w[i] * m[i] * m[i];
      sxy += w[i] * m[i] * target[i];
    }
    const det = sw * sxx - sx * sx;
    if (Math.abs(det) < 1e-12) return null;
    a = (sw * sxy - sx * sy) / det;
    b = (sy - a * sx) / sw;
    for (let i = 0; i < n; i++) r[i] = a * m[i] + b - target[i];
    spread = 1.4826 * median(Float64Array.from(r, Math.abs)) + 1e-6;
    const k = HUBER * spread;
    for (let i = 0; i < n; i++) w[i] = Math.abs(r[i]) <= k ? 1 : k / Math.abs(r[i]);
  }
  if (!(a > 0)) return null;
  const errors = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const inv = a * m[i] + b;
    errors[i] = inv > 0 ? Math.abs(1 / inv - z[i]) : z[i];
  }
  return { a, b, spread, error: median(errors), n };
}

function median(values) {
  const s = Float64Array.from(values).sort();
  return s.length ? s[s.length >> 1] : 0;
}

/** A guess for when nothing is metric: the model's 2nd-98th percentiles span NEAR..FAR metres. */
export function assumedFit(min, max) {
  const a = (1 / NEAR - 1 / FAR) / Math.max(max - min, 1e-6);
  return { a, b: 1 / FAR - a * min, spread: 0.15, error: null, n: 0, assumed: true };
}

/** Eases a fit toward the latest one, so the scene's scale doesn't pump frame to frame. */
export function blendFit(previous, next, amount = 0.35) {
  if (!previous || previous.assumed !== next.assumed) return next;
  const mix = (p, q) => p + (q - p) * amount;
  return { ...next, a: mix(previous.a, next.a), b: mix(previous.b, next.b), spread: mix(previous.spread, next.spread) };
}

/**
 * Metric depth and sigma per cell from model values on the grid. Sigma
 * comes from the fit's spread in inverse depth: dz = z²·dρ, so it grows
 * with the square of distance; an assumed scale is far less certain.
 */
export function applyFit(fit, values) {
  const depth = new Float32Array(values.length);
  const sigma = new Float32Array(values.length);
  const spread = fit.spread + (fit.assumed ? 0.2 : 0.02);
  for (let i = 0; i < values.length; i++) {
    const inv = fit.a * values[i] + fit.b;
    if (!(inv > 1 / MAX_DEPTH)) continue;
    const z = 1 / inv;
    depth[i] = z;
    sigma[i] = Math.min(z * z * spread, z);
  }
  return { depth, sigma };
}

/**
 * Combines two depth estimates per cell, weighting each by its inverse
 * variance (the product of two Gaussians). Where only one knows, it wins.
 */
export function fuseDepth(d1, s1, d2, s2) {
  const depth = new Float32Array(d1.length);
  const sigma = new Float32Array(d1.length);
  for (let i = 0; i < d1.length; i++) {
    const k1 = d1[i] > 0;
    const k2 = d2[i] > 0;
    if (k1 && k2) {
      const w1 = 1 / (s1[i] * s1[i]);
      const w2 = 1 / (s2[i] * s2[i]);
      depth[i] = (d1[i] * w1 + d2[i] * w2) / (w1 + w2);
      sigma[i] = Math.sqrt(1 / (w1 + w2));
    } else if (k1) {
      depth[i] = d1[i];
      sigma[i] = s1[i];
    } else if (k2) {
      depth[i] = d2[i];
      sigma[i] = s2[i];
    }
  }
  return { depth, sigma };
}
