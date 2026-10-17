import { useSyncExternalStore } from 'react';
import * as THREE from 'three';

// The latest depth frame (see grid.js), the camera image as it is right
// now, and a status summary for the panels. DepthSource writes them; the
// passthrough, the filters and the panels read them.

let frame = null;
let frameVersion = 0;
const frameListeners = new Set();

export const getDepthFrame = () => frame;

export function setDepthFrame(next) {
  frame = next;
  frameVersion++;
  frameListeners.forEach((l) => l());
}

export function subscribeDepthFrame(listener) {
  frameListeners.add(listener);
  return () => frameListeners.delete(listener);
}

/** Re-renders on each new depth frame; returns its version number. */
export const useDepthFrameVersion = () => useSyncExternalStore(subscribeDepthFrame, () => frameVersion);

/**
 * The camera as of this frame: its image (`texture`, null if none), and the
 * view it was taken from (`worldToCamera`, `projection`). The image has
 * v = 0 at the bottom of the view, as the XR camera image and a three
 * VideoTexture both do. Updated in place
 * each frame, before anything draws, so readers in useFrame see this frame's.
 */
export const liveCamera = {
  texture: null,
  worldToCamera: new THREE.Matrix4(),
  projection: new THREE.Matrix4(),
  /** The image's size in pixels. */
  size: new THREE.Vector2(640, 480),
};

/**
 * What the panels show: { source ('arcore' | 'arcore+ml' | 'ml' | 'test' |
 * null), arcore ('cpu' | 'gpu' | null: what the session granted), rawSize
 * ([w, h] of ARCore's depth), ml ({ state, provider, ms, progress, error }),
 * fit ({ error (metres), assumed, n } | null), anchors (hit-test points
 * held for the scale) }.
 */
let status = { source: null, arcore: null, rawSize: null, ml: { state: 'idle' }, fit: null, anchors: 0 };
let statusKey = JSON.stringify(status);
const statusListeners = new Set();

export const getDepthStatus = () => status;

/** Replaces the status, notifying only if what the panels would show changed. */
export function setDepthStatus(next) {
  const key = JSON.stringify(next);
  if (key === statusKey) return;
  status = next;
  statusKey = key;
  statusListeners.forEach((l) => l());
}

export function subscribeDepthStatus(listener) {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export const useDepthStatus = () => useSyncExternalStore(subscribeDepthStatus, getDepthStatus);
