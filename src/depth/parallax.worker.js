// Motion parallax (parallax.js) in a worker: tracking a thousand-odd patches
// takes tens of milliseconds, too long to spend inside an XR frame on a phone.
//
// Messages in:  { type: 'reset' } | { type: 'frame', id, image: { rgba, width, height }, base }
//   (`base`: the frame's grid and view, its matrices as arrays of 16)
// Messages out: { type: 'result', id, result } (see MotionParallax.estimate)
import * as THREE from 'three';
import { MotionParallax } from './parallax.js';

const parallax = new MotionParallax();
const MATRICES = ['cameraToWorld', 'worldToCamera', 'projection', 'projectionInverse'];

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'reset') return parallax.reset();
  const base = { ...msg.base };
  for (const key of MATRICES) base[key] = new THREE.Matrix4().fromArray(base[key]);
  const result = parallax.estimate(msg.image, base);
  const transfer = [result.depth, result.sigma].map((a) => a.buffer);
  self.postMessage({ type: 'result', id: msg.id, result }, transfer);
};
