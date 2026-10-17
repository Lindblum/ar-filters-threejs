import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { EYE_SEPARATION } from './SideBySide.jsx';

// 3D: Interlaced, row-interleaved stereo for passive (polarised) 3D monitors
// and TVs: the left eye on every other screen row, starting with the top one,
// and the right eye on the rows between. Each eye is drawn at full size into
// its own image, then a full-screen pass takes each row from one of them.
// Rows are device pixels, so it lines up with the screen's polariser at any
// browser zoom the canvas resolution follows.

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D left;
  uniform sampler2D right;
  uniform float height;
  varying vec2 vUv;
  void main() {
    // gl_FragCoord counts rows from the bottom; count from the top
    float row = height - 1.0 - floor(gl_FragCoord.y);
    gl_FragColor = mod(row, 2.0) < 0.5 ? texture2D(left, vUv) : texture2D(right, vUv);
    #include <colorspace_fragment>
  }
`;

const _size = new THREE.Vector2();

function eyeTarget() {
  // half float keeps the linear colours smooth until the final pass encodes them
  return new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
}

/** Takes over rendering while mounted; the camera and orbit controls carry on as usual. */
export function Interlaced() {
  const { stereo, targets, pass } = useMemo(() => {
    const s = new THREE.StereoCamera();
    s.eyeSep = EYE_SEPARATION;
    const left = eyeTarget();
    const right = eyeTarget();
    const material = new THREE.ShaderMaterial({
      uniforms: { left: { value: left.texture }, right: { value: right.texture }, height: { value: 1 } },
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    quad.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(quad);
    return { stereo: s, targets: [left, right], pass: { scene, camera: new THREE.OrthographicCamera(), material, quad } };
  }, []);
  useEffect(
    () => () => {
      targets.forEach((t) => t.dispose());
      pass.material.dispose();
      pass.quad.geometry.dispose();
    },
    [targets, pass],
  );

  useFrame(({ gl, scene, camera }) => {
    gl.getDrawingBufferSize(_size);
    for (const target of targets) if (target.width !== _size.x || target.height !== _size.y) target.setSize(_size.x, _size.y);
    pass.material.uniforms.height.value = _size.y;

    camera.updateMatrixWorld();
    stereo.update(camera);
    [stereo.cameraL, stereo.cameraR].forEach((eye, i) => {
      gl.setRenderTarget(targets[i]);
      gl.render(scene, eye);
    });
    gl.setRenderTarget(null);
    gl.render(pass.scene, pass.camera);
  }, 1); // priority > 0: R3F skips its own render while this runs

  return null;
}
