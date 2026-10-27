import * as THREE from 'three';

// Grip controls, read straight from the XR session.

const SQUEEZE = 1; // xr-standard gamepad button index

const _pose = new THREE.Matrix4();

/** Which hands' grips hold a panel just now (see XRPanels): their thumbsticks push and turn it, nothing else. */
export const holding = { left: false, right: false };

/**
 * Each controller's state in world space: { grip (Matrix4), position, ray,
 * squeeze, gamepad }, keyed by hand. Poses come relative to the XR origin,
 * which locomotion moves, so they're carried through its world matrix.
 */
export function readControllers(frame, referenceSpace, origin) {
  const hands = {};
  for (const source of frame.session.inputSources) {
    if (source.hand || !source.gripSpace || !source.gamepad) continue; // tracked hands have no grip button
    if (source.handedness !== 'left' && source.handedness !== 'right') continue;
    const gripPose = frame.getPose(source.gripSpace, referenceSpace);
    if (!gripPose) continue;
    const grip = new THREE.Matrix4().fromArray(gripPose.transform.matrix).premultiply(origin.matrixWorld);
    const ray = new THREE.Ray();
    const rayPose = frame.getPose(source.targetRaySpace, referenceSpace);
    if (rayPose) {
      _pose.fromArray(rayPose.transform.matrix).premultiply(origin.matrixWorld);
      ray.origin.setFromMatrixPosition(_pose);
      ray.direction.set(0, 0, -1).transformDirection(_pose);
    }
    hands[source.handedness] = {
      grip,
      position: new THREE.Vector3().setFromMatrixPosition(grip),
      ray,
      squeeze: Boolean(source.gamepad.buttons[SQUEEZE]?.pressed),
      gamepad: source.gamepad,
    };
  }
  return hands;
}
