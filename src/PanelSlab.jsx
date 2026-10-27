import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// Every XR panel's body, as in grid-game-threejs: a slab 1 cm deep in the
// world behind its face, its corners rounded like the face's frame, slightly
// see-through. A child of the face's mesh, centred on it.

const DEPTH_M = 0.01; // in the world, whatever the panel's scale
const MATERIAL = new THREE.MeshBasicMaterial({ color: 0x1c2230, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false });
const _scale = new THREE.Vector3();

/** A `width` × `height` slab (m, the face's own units) with corners of `radius`. */
export function PanelSlab({ width, height, radius }) {
  const mesh = useRef(null);
  const geometry = useMemo(() => {
    const shape = roundedShape(new THREE.Shape(), width, height, radius);
    // 1 deep, from the face back: scaled to DEPTH_M in the world each frame
    return new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false, curveSegments: 6 }).translate(0, 0, -1);
  }, [width, height, radius]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useFrame(() => {
    const m = mesh.current;
    if (!m?.parent) return;
    m.parent.getWorldScale(_scale);
    m.scale.z = DEPTH_M / (_scale.z || 1);
  });
  // (drawn just before the face, which draws over it; never hit by rays: the face takes presses)
  return <mesh ref={mesh} geometry={geometry} material={MATERIAL} renderOrder={899} raycast={() => null} />;
}

/** A rounded rectangle traced into `shape`, centred. */
function roundedShape(shape, w, h, r) {
  const x = -w / 2;
  const y = -h / 2;
  shape.moveTo(x + r, y);
  shape.lineTo(x + w - r, y);
  shape.quadraticCurveTo(x + w, y, x + w, y + r);
  shape.lineTo(x + w, y + h - r);
  shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  shape.lineTo(x + r, y + h);
  shape.quadraticCurveTo(x, y + h, x, y + h - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  return shape;
}
