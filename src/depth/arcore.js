// ARCore depth through WebXR depth-sensing. ARCore estimates it from the
// phone's own motion (and a depth sensor where there is one), so many phones
// without one still report it: about 160 x 90, metric, smoothed, up to ~8 m,
// with no confidence. Only the CPU path is read here; a session that grants
// only gpu-optimized depth leaves this unavailable and the ML model steps in.

/** Session options for depth-sensing, CPU access first. */
export const DEPTH_SENSING_INIT = {
  usagePreference: ['cpu-optimized', 'gpu-optimized'],
  dataFormatPreference: ['luminance-alpha', 'unsigned-short', 'float32'],
};

const MAX_DEPTH = 8; // metres; beyond this ARCore's estimate is mostly guesswork
const SIGMA_K = 0.015; // sigma grows with the square of distance, like any parallax-based depth
const SIGMA_FLOOR = 0.01;

/** What this session's depth-sensing offers: 'cpu', 'gpu' (unusable here) or null. */
export function arcoreDepthMode(session) {
  if (!session?.enabledFeatures?.includes('depth-sensing')) return null;
  return session.depthUsage === 'cpu-optimized' ? 'cpu' : 'gpu';
}

/** The usual sigma for an ARCore depth of `z` metres. */
export const arcoreSigma = (z) => SIGMA_FLOOR + SIGMA_K * z * z;

/**
 * This frame's ARCore depth resampled onto a width x height grid over
 * `view` (see grid.js), or null if there is none this frame. Nearest
 * sample, so object edges stay sharp instead of blending into ramps.
 */
export function readArcoreDepth(frame, view, width, height) {
  let info;
  try {
    info = frame.getDepthInformation(view);
  } catch {
    return null; // not a CPU depth session, or not this frame
  }
  if (!info?.data || !info.width) return null;
  const format = frame.session.depthDataFormat;
  const raw = format === 'float32' ? new Float32Array(info.data) : new Uint16Array(info.data);
  const scale = info.rawValueToMeters;
  // normalized view coordinates (u right, v down) -> depth buffer coordinates
  const m = info.normDepthBufferFromNormView.matrix;
  const depth = new Float32Array(width * height);
  for (let j = 0; j < height; j++) {
    const v = (j + 0.5) / height;
    for (let i = 0; i < width; i++) {
      const u = (i + 0.5) / width;
      const du = m[0] * u + m[4] * v + m[12];
      const dv = m[1] * u + m[5] * v + m[13];
      const x = Math.min(info.width - 1, Math.max(0, Math.floor(du * info.width)));
      const y = Math.min(info.height - 1, Math.max(0, Math.floor(dv * info.height)));
      const d = raw[y * info.width + x] * scale;
      depth[j * width + i] = d > 0 && d < MAX_DEPTH ? d : 0;
    }
  }
  return { depth, rawWidth: info.width, rawHeight: info.height };
}
