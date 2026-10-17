import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useXR } from '@react-three/xr';
import * as THREE from 'three';
import { arcoreDepthMode, arcoreSigma, readArcoreDepth } from './arcore.js';
import { CameraCapture } from './capture.js';
import { bilateral, edgeStrength, gridColor, gridSize, sampleBilinear } from './grid.js';
import { groundPlane, sceneCues } from './heuristics.js';
import { depthModel, modelInputSize } from './ml.js';
import { ParallaxWorker } from './parallax.js';
import { applyFit, assumedFit, blendFit, fitInverseDepth, fuseDepth, valueRange } from './scale.js';
import { smoothFrame } from './smooth.js';
import { getDepthStatus, liveCamera, setDepthFrame, setDepthStatus } from './store.js';

// Makes depth frames (see grid.js) with the chosen algorithm (Depth → Algorithm):
//   auto: ARCore's depth (WebXR depth-sensing), metric but coarse, sharpened
//     by Depth Anything V2 while the model keeps up;
//   arcore: ARCore's depth alone;
//   da2, da3, midas: a depth model on the camera image (camera-access);
//   cues: picture cues (heuristics.js);
//   ground: the floor under every ray (heuristics.js);
//   parallax: points tracked between frames and triangulated (parallax.js);
//   off: none.
// The models and scene cues give relative depth, scaled to metres against
// ARCore's depth where the phone has it, else hit tests on surfaces, else an
// assumed range. Ground plane and motion parallax are metric by themselves.
// On the desktop the test feed's video stands in for the camera, with a
// fixed pose (so no ARCore, no hit tests, and parallax falls back to flow).

const INTERVAL = 0.1; // seconds between captures, at most
const ML_TOO_SLOW_MS = 250; // auto mode drops the model above this (after warm-up)
const ML_WARMUP = 3;
const ARCORE_STRIDE = 3; // every third grid cell is enough to fit a relative estimate's scale
const ANCHOR_RAYS = [
  [0, 0],
  [0.25, 0.2],
  [-0.25, 0.2],
  [0.25, -0.2],
  [-0.25, -0.2],
]; // hit-test directions, tangent units from the view's centre
const ANCHOR_AGE = 10; // seconds a hit-test point is kept
const ANCHOR_MAX = 300;
const EDGE_GAIN = 3; // sigma grows by up to this many times at depth edges

/** The depth model each mode runs, if any: auto sharpens ARCore with Depth Anything V2. */
const MODEL_OF = { auto: 'da2', da2: 'da2', da3: 'da3', midas: 'midas' };

/** The desktop test feed's camera: eye height, looking straight ahead. */
export const TEST_CAMERA = { position: [0, 1.3, 0], fov: 60 };

const _v = new THREE.Vector4();

/** The model's output resampled onto the grid. */
function modelGrid(result, width, height) {
  const out = new Float32Array(width * height);
  for (let j = 0; j < height; j++)
    for (let i = 0; i < width; i++)
      out[j * width + i] = sampleBilinear(result.data, result.width, result.height, (i + 0.5) / width, (j + 0.5) / height, false);
  return out;
}

/** Pairs of (relative value, metric depth) from ARCore's grid. */
function pairsFromGrid(values, depth) {
  const m = [];
  const z = [];
  for (let i = 0; i < depth.length; i += ARCORE_STRIDE) {
    if (!(depth[i] > 0)) continue;
    m.push(values[i]);
    z.push(depth[i]);
  }
  return { m, z };
}

/** Pairs from hit-test points (world space) seen by the capture's view. */
function pairsFromAnchors(values, width, height, anchors, worldToCamera, projection) {
  const m = [];
  const z = [];
  for (const p of anchors) {
    _v.set(p.x, p.y, p.z, 1).applyMatrix4(worldToCamera);
    const depth = -_v.z;
    if (depth <= 0.05) continue;
    _v.applyMatrix4(projection);
    const u = (_v.x / _v.w + 1) / 2;
    const v = (1 - _v.y / _v.w) / 2;
    if (u < 0 || u > 1 || v < 0 || v > 1) continue;
    m.push(sampleBilinear(values, width, height, u, v, false));
    z.push(depth);
  }
  return { m, z };
}

/** Sigma from ARCore's distance model, grown at depth edges. */
function arcoreSigmas(depth, edges) {
  const sigma = new Float32Array(depth.length);
  for (let i = 0; i < depth.length; i++) if (depth[i] > 0) sigma[i] = arcoreSigma(depth[i]) * (1 + EDGE_GAIN * edges[i]);
  return sigma;
}

function arcoreOnly(depth, color, width, height) {
  const refined = color ? bilateral(depth, color, width, height) : depth;
  return { depth: refined, sigma: arcoreSigmas(refined, edgeStrength(refined, width, height)) };
}

const freshRun = () => ({ last: -Infinity, busy: false, fit: null, mlRuns: 0, mlMs: 0, mlSlow: false, smoothed: null });

/**
 * `mode`: see the top of this file. `smoothing`: 0 (off) to 1 (see
 * smooth.js). `video`: the desktop test feed's <video>, or null.
 */
export function DepthSource({ mode, smoothing = 0.5, video }) {
  const gl = useThree((s) => s.gl);
  const capture = useMemo(() => new CameraCapture(), []);
  useEffect(() => () => capture.dispose(), [capture]);
  const parallax = useMemo(() => new ParallaxWorker(), []);
  const run = useRef(freshRun());
  const smoothingRef = useRef(smoothing);
  smoothingRef.current = smoothing;
  const anchors = useRef({ sources: [], points: [], session: null, lastT: -Infinity });
  const videoTexture = useMemo(() => {
    if (!video) return null;
    const t = new THREE.VideoTexture(video);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [video]);
  useEffect(() => () => videoTexture?.dispose(), [videoTexture]);

  // a chosen model loads at once, ready for XR; auto's loads once there's a camera to run it on
  const session = useXR((s) => s.session);
  const model = MODEL_OF[mode] ?? null;
  useEffect(() => {
    if (model && (mode !== 'auto' || session || video)) depthModel.load(model);
  }, [model, mode, session, video]);
  useEffect(() => depthModel.subscribe(() => setDepthStatus({ ...getDepthStatus(), ml: mlStatus(run.current) })), []);
  // a new mode, session or feed starts over
  useEffect(() => {
    run.current = freshRun();
    parallax.reset();
    setDepthFrame(null);
  }, [mode, session, video, parallax]);

  useFrame(({ clock }, _, frame) => {
    const t = clock.elapsedTime;
    const state = run.current;
    const xrSession = gl.xr.getSession();
    liveCamera.texture = null;

    if (video && !xrSession) {
      testFeedFrame(t);
      return;
    }
    if (!xrSession || !frame) {
      setDepthStatus({ source: null, arcore: null, rawSize: null, ml: mlStatus(state), fit: null, anchors: 0 });
      return;
    }
    const referenceSpace = gl.xr.getReferenceSpace();
    const view = frame.getViewerPose(referenceSpace)?.views[0];
    if (!view) return;

    // this frame's camera, for drawing
    const xrCamera = view.camera;
    const texture = xrCamera ? gl.xr.getCameraTexture(xrCamera) : null;
    liveCamera.texture = texture?.sourceTexture ? texture : null;
    if (xrCamera) liveCamera.size.set(xrCamera.width, xrCamera.height);
    liveCamera.worldToCamera.fromArray(view.transform.inverse.matrix);
    liveCamera.projection.fromArray(view.projectionMatrix);

    collectAnchors(frame, xrSession, referenceSpace, t);
    if (mode === 'off' || state.busy || t - state.last < INTERVAL) return;

    const arcoreMode = arcoreDepthMode(xrSession);
    const proj = view.projectionMatrix;
    const aspect = xrCamera ? xrCamera.width / xrCamera.height : proj[5] / proj[0];
    const { width, height } = gridSize(aspect);
    // ARCore's depth: the depth itself in auto and arcore modes, the scale for relative estimates in the rest
    const arcore = arcoreMode === 'cpu' ? readArcoreDepth(frame, view, width, height) : null;
    const kind = estimator(Boolean(arcore), Boolean(liveCamera.texture));
    const status = { arcore: arcoreMode, rawSize: arcore ? [arcore.rawWidth, arcore.rawHeight] : null };
    if (!kind) {
      setDepthStatus({ ...getDepthStatus(), ...status, source: null, ml: mlStatus(state) });
      return;
    }
    state.last = t;
    const base = {
      width,
      height,
      posed: true,
      cameraToWorld: new THREE.Matrix4().fromArray(view.transform.matrix),
      projectionInverse: new THREE.Matrix4().fromArray(proj).invert(),
      worldToCamera: liveCamera.worldToCamera.clone(),
      projection: liveCamera.projection.clone(),
    };
    if (!liveCamera.texture) {
      // no camera image: only what needs none
      if (kind === 'arcore') publish({ ...base, ...arcoreOnly(arcore.depth, null, width, height), color: null, source: 'arcore' }, status);
      else publish({ ...base, ...groundPlane(base), color: null, source: 'ground' }, status);
      return;
    }
    state.busy = true;
    capture
      .captureTexture(gl, liveCamera.texture, modelInputSize(kind === 'model' ? model : 'da2', aspect))
      .then((image) => process(image, base, kind, arcore?.depth ?? null, status))
      .catch((e) => console.warn('[depth-xr] camera capture failed:', e))
      .finally(() => {
        state.busy = false;
      });
  }, -2);

  /**
   * Which estimate to make this frame, given whether there's ARCore depth
   * and a camera image: 'model' | 'arcore' | 'cues' | 'ground' | 'parallax',
   * or null for none.
   */
  function estimator(hasArcore, hasCamera) {
    const modelFree = model && depthModel.isReady(model) && !depthModel.busy && hasCamera;
    if (mode === 'auto') return modelFree && !(run.current.mlSlow && hasArcore) ? 'model' : hasArcore ? 'arcore' : null;
    if (mode === 'arcore') return hasArcore ? 'arcore' : null;
    if (model) return modelFree ? 'model' : null;
    if (mode === 'ground') return 'ground';
    if (mode === 'cues' || mode === 'parallax') return hasCamera ? mode : null;
    return null;
  }

  /** The desktop test feed: the video's frames, from a fixed camera. */
  function testFeedFrame(t) {
    const state = run.current;
    if (!video.videoWidth) return;
    const aspect = video.videoWidth / video.videoHeight;
    const projection = new THREE.PerspectiveCamera(TEST_CAMERA.fov, aspect, 0.05, 100).projectionMatrix;
    const cameraToWorld = new THREE.Matrix4().makeTranslation(...TEST_CAMERA.position);
    liveCamera.worldToCamera.copy(cameraToWorld).invert();
    liveCamera.projection.copy(projection);
    liveCamera.texture = videoTexture;
    liveCamera.size.set(video.videoWidth, video.videoHeight);
    if (mode === 'off' || state.busy || t - state.last < INTERVAL) return;
    const kind = estimator(false, true);
    if (!kind) return;
    state.last = t;
    state.busy = true;
    const { width, height } = gridSize(aspect);
    const base = {
      width,
      height,
      posed: false, // it never moves, so parallax can't triangulate
      cameraToWorld,
      projectionInverse: projection.clone().invert(),
      worldToCamera: cameraToWorld.clone().invert(),
      projection: projection.clone(),
    };
    const image = capture.captureVideo(video, modelInputSize(kind === 'model' ? model : 'da2', aspect));
    process(image, base, kind, null, { arcore: null, rawSize: null, test: true }).finally(() => {
      state.busy = false;
    });
  }

  /** Turns a captured image (and ARCore's grid, if any) into a depth frame with the estimator `kind`. */
  async function process(image, base, kind, arcoreDepth, status) {
    const { width, height } = base;
    const state = run.current;
    const color = gridColor(image.rgba, image.width, image.height, width, height);
    const t0 = performance.now();
    let estimate; // { values, range } (relative) or { depth, sigma } (metric)
    let ms = null;
    let extra = {};
    if (kind === 'model') {
      const result = await depthModel.run(image.rgba, image.width, image.height);
      if (!result) {
        if (mode === 'auto' && arcoreDepth) publish({ ...base, ...arcoreOnly(arcoreDepth, color, width, height), color, source: 'arcore' }, status);
        return;
      }
      noteModelTime(result.ms);
      ms = result.ms;
      estimate = { values: modelGrid(result, width, height), range: [result.min, result.max] };
    } else if (kind === 'cues') {
      const values = sceneCues(color, width, height);
      estimate = { values, range: valueRange(values) };
    } else if (kind === 'parallax') {
      const t1 = performance.now();
      const r = await parallax.estimate(image, base);
      if (!r) return; // reset meanwhile
      ms = performance.now() - t1;
      estimate = r.values ? { values: r.values, range: valueRange(r.values) } : r;
      if (!r.values) extra = { parallax: { baseline: Math.round(r.baseline * 100), tracked: Math.round(r.tracked * 100) } };
    } else if (kind === 'ground') estimate = groundPlane(base);
    else estimate = arcoreOnly(arcoreDepth, color, width, height);
    ms ??= performance.now() - t0;

    let { depth, sigma } = estimate;
    let fitted = false;
    if (estimate.values) {
      // relative: scale it to metres
      const pairs = arcoreDepth
        ? pairsFromGrid(estimate.values, arcoreDepth)
        : pairsFromAnchors(estimate.values, width, height, anchors.current.points, base.worldToCamera, base.projection);
      const fit = fitInverseDepth(pairs.m, pairs.z) ?? assumedFit(...estimate.range);
      state.fit = blendFit(state.fit, fit);
      ({ depth, sigma } = applyFit(state.fit, estimate.values));
      fitted = true;
      if (mode === 'auto' && arcoreDepth)
        ({ depth, sigma } = fuseDepth(depth, sigma, arcoreDepth, arcoreSigmas(arcoreDepth, edgeStrength(arcoreDepth, width, height))));
      const edges = edgeStrength(depth, width, height);
      for (let i = 0; i < sigma.length; i++) sigma[i] *= 1 + EDGE_GAIN * edges[i];
    }
    const source = mode === 'auto' ? (kind === 'model' ? (arcoreDepth ? 'arcore+da2' : 'da2') : 'arcore') : mode;
    publish({ ...base, depth, sigma, color, source }, { ...status, ...extra, ms: Math.round(ms), fitted });
  }

  function publish(raw, status) {
    raw.time = performance.now();
    const depthFrame = smoothFrame(run.current.smoothed, raw, smoothingRef.current);
    run.current.smoothed = depthFrame;
    setDepthFrame(depthFrame);
    const fit = run.current.fit;
    setDepthStatus({
      source: depthFrame.source,
      ...status,
      ml: mlStatus(run.current),
      fit: status.fitted && fit ? { error: fit.error, assumed: Boolean(fit.assumed), n: fit.n } : null,
      anchors: anchors.current.points.length,
    });
  }

  /** Auto mode's judgement of the model: its average time after warm-up. */
  function noteModelTime(ms) {
    const state = run.current;
    state.mlRuns++;
    if (state.mlRuns <= ML_WARMUP) return;
    const n = state.mlRuns - ML_WARMUP;
    state.mlMs += (ms - state.mlMs) / Math.min(n, 10);
    if (n >= 5 && state.mlMs > ML_TOO_SLOW_MS) state.mlSlow = true;
  }

  /** Hit-test points on real surfaces near the view's centre, for scaling relative depth without ARCore's. */
  function collectAnchors(frame, xrSession, referenceSpace, t) {
    const a = anchors.current;
    if (a.session !== xrSession) {
      a.sources.forEach((s) => s.cancel?.());
      a.session = xrSession;
      a.sources = [];
      a.points = [];
      if (xrSession.enabledFeatures?.includes('hit-test') && typeof XRRay !== 'undefined')
        xrSession
          .requestReferenceSpace('viewer')
          .then((viewer) =>
            Promise.all(
              ANCHOR_RAYS.map(([x, y]) =>
                xrSession.requestHitTestSource({ space: viewer, offsetRay: new XRRay({ x: 0, y: 0, z: 0 }, { x, y, z: -1 }) }),
              ),
            ),
          )
          .then((sources) => {
            if (a.session === xrSession) a.sources = sources;
            else sources.forEach((s) => s.cancel());
          })
          .catch((e) => console.warn('[depth-xr] no hit testing; relative depth will use an assumed scale without ARCore depth:', e));
    }
    if (!a.sources.length || t - a.lastT < INTERVAL) return;
    a.lastT = t;
    for (const source of a.sources) {
      const p = frame.getHitTestResults(source)[0]?.getPose(referenceSpace)?.transform.position;
      if (p) a.points.push({ x: p.x, y: p.y, z: p.z, t });
    }
    a.points = a.points.filter((p) => t - p.t < ANCHOR_AGE).slice(-ANCHOR_MAX);
  }

  return null;
}

function mlStatus(state) {
  return {
    model: depthModel.model,
    state: depthModel.state,
    provider: depthModel.provider,
    progress: Math.round(depthModel.progress * 100),
    error: depthModel.error,
    ms: state.mlRuns > ML_WARMUP ? Math.round(state.mlMs / 5) * 5 : null,
    slow: state.mlSlow,
  };
}
