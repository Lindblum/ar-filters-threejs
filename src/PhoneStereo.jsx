import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { CardboardLens } from './CardboardLens.js';
import { DEPTH_SENSING_INIT } from './depth/arcore.js';

// Stereo on top of a phone's WebXR AR session. ARCore supplies full 6DoF
// tracking, so the model stays where it is in the room and you can walk
// around it, but a phone session has a single view. Here that view is split
// into two eyes for a Cardboard-style viewer, with the viewer's lens optics
// (see CardboardLens).
//
// three.js builds its XR camera from the session's views each frame and then
// calls renderer.xr.updateCamera(); while this component is mounted that call
// is replaced with one that derives two eye cameras from the tracked pose.
//
// Chrome keeps an AR session in the orientation it started in, so a session
// begun with the phone upright stays portrait after the phone goes sideways
// into a viewer. The eyes are then laid out along the screen's long side,
// rolled 90 degrees so they are upright for the person holding it.

/**
 * This frame's eye layout: `width` x `height` is the landscape side-by-side
 * image; `rotation` turns it onto the framebuffer (0 landscape, +1 / -1
 * portrait with the phone turned one way or the other).
 */
const layout = { width: 1, height: 1, rotation: 0 };
const _roll = new THREE.Matrix4();

function updateLayout(gl, framebufferWidth, framebufferHeight) {
  const portrait = framebufferHeight > framebufferWidth;
  if (!portrait) {
    layout.rotation = 0;
  } else {
    // which way the screen's x axis points in the room: up or down
    const screenRightUp = gl.xr.getCamera().matrix.elements[1];
    if (Math.abs(screenRightUp) > 0.3) layout.rotation = screenRightUp > 0 ? -1 : 1;
    else if (layout.rotation === 0) layout.rotation = 1; // held flat: keep a sideways layout
  }
  layout.width = portrait ? framebufferHeight : framebufferWidth;
  layout.height = portrait ? framebufferWidth : framebufferHeight;
}

/**
 * The phone AR session's options: raw camera access (for drawing the camera
 * image in the room, filtered, and for the depth model), ARCore depth, and hit tests
 * (to scale the model's depth when there's no ARCore depth).
 */
export const PHONE_AR_SESSION_INIT = {
  requiredFeatures: ['local-floor'],
  optionalFeatures: ['camera-access', 'depth-sensing', 'hit-test', 'anchors', 'hand-tracking'],
  depthSensing: DEPTH_SENSING_INIT,
};

/**
 * `strength`: the eyes' separation, times the viewer's lens spacing (1: true
 * to scale). Everything is drawn true to scale: the camera sees less than
 * the lenses show, and the depth passthrough's outfill covers the rest.
 */
export function PhoneStereoXR({ strength = 1 }) {
  const gl = useThree((s) => s.gl);
  const lens = useMemo(() => new CardboardLens(), []);
  useEffect(() => () => lens.dispose(), [lens]);
  lens.ipdScale = strength;

  // Render the two eyes (via the camera override below) into an offscreen
  // image the size of the XR framebuffer, then draw it through the lens warp
  // into that framebuffer. Priority > 0: R3F skips its own render.
  useFrame(({ scene, camera }) => {
    const xrTarget = gl.getRenderTarget(); // the session's framebuffer, bound by three for this frame
    if (!xrTarget) return;
    updateLayout(gl, xrTarget.width, xrTarget.height);
    lens.setLayout(layout.width, layout.height, layout.rotation);
    gl.setRenderTarget(lens.target);
    gl.render(scene, camera);
    // a plain full-screen pass: keep three from substituting the XR camera
    gl.xr.enabled = false;
    gl.setRenderTarget(xrTarget);
    lens.render(gl);
    gl.xr.enabled = true;
  }, 1);

  useEffect(() => {
    const xr = gl.xr;
    const original = xr.updateCamera;
    // three's own per-view cameras, put back when stereo is switched off
    const originalCameras = [...xr.getCamera().cameras];
    const head = new THREE.Matrix4();
    // a wide square frustum covers both eyes in either layout, for culling
    const culling = new THREE.PerspectiveCamera(150, 1, 0.05, 1000);
    const eyes = [0, 1].map((i) => {
      const eye = new THREE.PerspectiveCamera();
      eye.matrixAutoUpdate = false;
      eye.viewport = new THREE.Vector4();
      eye.layers.enable(i + 1);
      return eye;
    });
    const parentInverse = new THREE.Matrix4();

    xr.updateCamera = function updatePhoneStereoCamera(camera) {
      const cameraXR = xr.getCamera();
      if (!cameraXR.cameras[0]?.viewport) return original.call(xr, camera);

      const parent = camera.parent;
      cameraXR.matrixWorld.copy(cameraXR.matrix);
      if (parent) cameraXR.matrixWorld.premultiply(parent.matrixWorld);
      cameraXR.matrixWorldInverse.copy(cameraXR.matrixWorld).invert();

      // eyes side by side in the landscape layout (offscreen, from 0,0)
      const eyeWidth = layout.width / 2;
      const height = layout.height;
      culling.near = camera.near;
      culling.far = camera.far;
      // roll the head with the phone so the eyes sit along its long side
      head.copy(cameraXR.matrixWorld).multiply(_roll.makeRotationZ((layout.rotation * Math.PI) / 2));
      eyes.forEach((eye, i) => {
        lens.eyeCamera(i, head, camera.near, camera.far, eye);
        eye.viewport.set(i * eyeWidth, 0, eyeWidth, height);
      });
      cameraXR.cameras.length = 0;
      cameraXR.cameras.push(...eyes);

      culling.updateProjectionMatrix();
      cameraXR.projectionMatrix.copy(culling.projectionMatrix);
      cameraXR.projectionMatrixInverse.copy(culling.projectionMatrixInverse);

      // the app's camera follows the head (the gaze reticle reads it)
      if (parent) camera.matrix.copy(parentInverse.copy(parent.matrixWorld).invert()).multiply(cameraXR.matrixWorld);
      else camera.matrix.copy(cameraXR.matrixWorld);
      camera.matrix.decompose(camera.position, camera.quaternion, camera.scale);
      camera.updateMatrixWorld(true);
      camera.projectionMatrix.copy(cameraXR.projectionMatrix);
      camera.projectionMatrixInverse.copy(cameraXR.projectionMatrixInverse);
    };

    return () => {
      xr.updateCamera = original;
      const cameras = xr.getCamera().cameras;
      cameras.length = 0;
      cameras.push(...originalCameras);
    };
  }, [gl, lens]);

  return null;
}
