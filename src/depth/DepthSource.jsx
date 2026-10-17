import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useXR } from '@react-three/xr';
import * as THREE from 'three';
import { arcoreDepthMode, arcoreSigma, readArcoreDepth } from './arcore.js';
import { CameraCapture } from './capture.js';
import { bilateral, edgeStrength, gridColor, gridSize, sampleBilinear } from './grid.js';
import { depthModel } from './ml.js';
import { applyFit, assumedFit, blendFit, fitInverseDepth, fuseDepth } from './scale.js';
import { getDepthStatus, liveCamera, setDepthFrame, setDepthStatus } from './store.js';

// Makes depth frames (see grid.js) from whatever this session offers:
//   ARCore depth (WebXR depth-sensing), metric but coarse and smooth;
//   Depth Anything on the camera image (camera-access), sharp but relative,
//   scaled to metres by ARCore's depth or, without it, by hit tests on
//   surfaces;
//   or, on the desktop, the test feed's video with the model alone.
// Modes: 'auto' uses ARCore, plus the model while it keeps up; 'arcore' and
// 'ml' use only that one; 'off' makes none.

const INTERVAL = 0.1; // seconds between captures, at most
const ML_TOO_SLOW_MS = 250; // auto mode drops the model above this (after warm-up)
const ML_WARMUP = 3;
const ARCORE_STRIDE = 3; // every third grid cell is enough to fit the model's scale
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

/** Pairs of (model value, metric depth) from ARCore's grid. */
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

/**
 * `mode`: 'auto' | 'arcore' | 'ml' | 'off'. `video`: the desktop test
 * feed's <video>, or null.
 */
export function DepthSource({ mode, video }) {
  const gl = useThree((s) => s.gl);
  const capture = useMemo(() => new CameraCapture(), []);
  useEffect(() => () => capture.dispose(), [capture]);
  const run = useRef({ last: -Infinity, busy: false, fit: null, mlRuns: 0, mlMs: 0, mlSlow: false });
  const anchors = useRef({ sources: [], points: [], session: null, lastT: -Infinity });
  const videoTexture = useMemo(() => {
    if (!video) return null;
    const t = new THREE.VideoTexture(video);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [video]);
  useEffect(() => () => videoTexture?.dispose(), [videoTexture]);

  // the model loads on first need: always in ML mode, in auto once a session starts, and for the test feed
  const session = useXR((s) => s.session);
  useEffect(() => {
    if (mode === 'ml' || (mode === 'auto' && session) || (mode !== 'off' && video)) depthModel.load();
  }, [mode, session, video]);
  useEffect(
    () =>
      depthModel.subscribe(() => {
        const s = getDepthStatus();
        setDepthStatus({ ...s, ml: mlStatus(run.current) });
      }),
    [],
  );
  // a new session or mode starts over
  useEffect(() => {
    run.current = { last: -Infinity, busy: false, fit: null, mlRuns: 0, mlMs: 0, mlSlow: false };
    setDepthFrame(null);
  }, [mode, video]);

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
    const useArcore = mode !== 'ml' && arcoreMode === 'cpu';
    // auto drops a slow model only when ARCore can carry on without it
    const modelWanted = mode === 'ml' || (mode === 'auto' && !(state.mlSlow && useArcore));
    const useModel = modelWanted && depthModel.state === 'ready' && !depthModel.busy;
    const proj = view.projectionMatrix;
    const aspect = xrCamera ? xrCamera.width / xrCamera.height : proj[5] / proj[0];
    const { width, height } = gridSize(aspect);
    const arcore = useArcore ? readArcoreDepth(frame, view, width, height) : null;
    if (!arcore && !(useModel && liveCamera.texture)) {
      reportIdle(arcoreMode);
      return;
    }
    state.last = t;
    const base = {
      width,
      height,
      cameraToWorld: new THREE.Matrix4().fromArray(view.transform.matrix),
      projectionInverse: new THREE.Matrix4().fromArray(proj).invert(),
      worldToCamera: liveCamera.worldToCamera.clone(),
      projection: liveCamera.projection.clone(),
    };
    const status = { arcore: arcoreMode, rawSize: arcore ? [arcore.rawWidth, arcore.rawHeight] : null };

    if (!liveCamera.texture) {
      publish({ ...base, ...arcoreOnly(arcore.depth, null, width, height), color: null, source: 'arcore' }, status);
      return;
    }
    state.busy = true;
    capture
      .captureTexture(gl, liveCamera.texture, aspect)
      .then((image) => process(image, base, arcore?.depth ?? null, useModel, status))
      .catch((e) => console.warn('[depth-xr] camera capture failed:', e))
      .finally(() => {
        state.busy = false;
      });
  }, -2);

  /** The desktop test feed: the video's frames through the model, at an assumed scale. */
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
    if (mode === 'off' || state.busy || t - state.last < INTERVAL || depthModel.state !== 'ready' || depthModel.busy) return;
    state.last = t;
    state.busy = true;
    const { width, height } = gridSize(aspect);
    const base = {
      width,
      height,
      cameraToWorld,
      projectionInverse: projection.clone().invert(),
      worldToCamera: cameraToWorld.clone().invert(),
      projection: projection.clone(),
    };
    process(capture.captureVideo(video), base, null, true, { arcore: null, rawSize: null }, true).finally(() => {
      state.busy = false;
    });
  }

  /** Turns a captured image (and ARCore's grid, if any) into a depth frame. */
  async function process(image, base, arcoreDepth, useModel, status, test = false) {
    const { width, height } = base;
    const color = gridColor(image.rgba, image.width, image.height, width, height);
    const result = useModel ? await depthModel.run(image.rgba, image.width, image.height) : null;
    if (!result) {
      if (arcoreDepth) publish({ ...base, ...arcoreOnly(arcoreDepth, color, width, height), color, source: 'arcore' }, status);
      return;
    }
    noteModelTime(result.ms);
    const values = modelGrid(result, width, height);
    const state = run.current;
    const pairs = arcoreDepth
      ? pairsFromGrid(values, arcoreDepth)
      : pairsFromAnchors(values, width, height, anchors.current.points, base.worldToCamera, base.projection);
    const fit = fitInverseDepth(pairs.m, pairs.z) ?? assumedFit(result.min, result.max);
    state.fit = blendFit(state.fit, fit);
    let { depth, sigma } = applyFit(state.fit, values);
    if (arcoreDepth) ({ depth, sigma } = fuseDepth(depth, sigma, arcoreDepth, arcoreSigmas(arcoreDepth, edgeStrength(arcoreDepth, width, height))));
    const edges = edgeStrength(depth, width, height);
    for (let i = 0; i < sigma.length; i++) sigma[i] *= 1 + EDGE_GAIN * edges[i];
    const source = test ? 'test' : arcoreDepth ? 'arcore+ml' : 'ml';
    publish({ ...base, depth, sigma, color, source }, status);
  }

  function arcoreOnly(depth, color, width, height) {
    const refined = color ? bilateral(depth, color, width, height) : depth;
    return { depth: refined, sigma: arcoreSigmas(refined, edgeStrength(refined, width, height)) };
  }

  function publish(depthFrame, status) {
    depthFrame.time = performance.now();
    setDepthFrame(depthFrame);
    const fit = run.current.fit;
    setDepthStatus({
      source: depthFrame.source,
      ...status,
      ml: mlStatus(run.current),
      fit: depthFrame.source === 'arcore' || !fit ? null : { error: fit.error, assumed: Boolean(fit.assumed), n: fit.n },
      anchors: anchors.current.points.length,
    });
  }

  function reportIdle(arcoreMode) {
    setDepthStatus({ ...getDepthStatus(), source: null, arcore: arcoreMode, ml: mlStatus(run.current) });
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

  /** Hit-test points on real surfaces near the view's centre, for scaling the model without ARCore depth. */
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
          .catch((e) => console.warn('[depth-xr] no hit testing; the model will use an assumed scale without ARCore depth:', e));
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
    state: depthModel.state,
    provider: depthModel.provider,
    progress: Math.round(depthModel.progress * 100),
    error: depthModel.error,
    ms: state.mlRuns > ML_WARMUP ? Math.round(state.mlMs / 5) * 5 : null,
    slow: state.mlSlow,
  };
}
