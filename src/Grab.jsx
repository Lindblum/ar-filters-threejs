import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { readControllers } from './grip.js';

// Touch controller grips. A grip pressed while that controller points at the
// menu panel carries the panel, held rigidly in the hand. A grip pressed
// anywhere else does nothing until it is let go.

const HANDS = ['left', 'right'];

const _world = new THREE.Matrix4();
const _parentInverse = new THREE.Matrix4();

function isShown(object) {
  for (let o = object; o; o = o.parent) if (!o.visible) return false;
  return true;
}

/** Sets `object`'s world pose to `grip` · `offset`, whatever its parent. */
function carry(object, grip, offset) {
  _parentInverse.copy(object.parent.matrixWorld).invert();
  _world.multiplyMatrices(grip, offset).premultiply(_parentInverse);
  _world.decompose(object.position, object.quaternion, object.scale);
}

/**
 * Grip controls for the menu panel. `menu` and `origin` (the XROrigin the
 * controllers are tracked relative to) are refs.
 */
export function useControllerGrips({ menu, origin }) {
  const gl = useThree((s) => s.gl);
  const grabs = useRef({}); // hand -> { target: 'none' } | { target: 'menu', offset }
  const raycaster = useMemo(() => new THREE.Raycaster(), []);

  useFrame((_, __, frame) => {
    const referenceSpace = gl.xr.getReferenceSpace();
    if (!frame || !origin.current || !referenceSpace) {
      grabs.current = {};
      return;
    }
    const controllers = readControllers(frame, referenceSpace, origin.current);
    for (const hand of HANDS) {
      const c = controllers[hand];
      if (!c?.squeeze) {
        delete grabs.current[hand];
        continue;
      }
      let grab = grabs.current[hand];
      if (!grab) {
        // a new grip: the menu if this controller is pointing at it
        raycaster.ray.copy(c.ray);
        const panel = menu.current;
        grab =
          panel && isShown(panel) && raycaster.intersectObject(panel, true).length
            ? { target: 'menu', offset: c.grip.clone().invert().multiply(panel.matrixWorld) }
            : { target: 'none' };
        grabs.current[hand] = grab;
      }
      if (grab.target === 'menu' && menu.current) carry(menu.current, c.grip, grab.offset); // keeps its pose in the hand
    }
  });
}
