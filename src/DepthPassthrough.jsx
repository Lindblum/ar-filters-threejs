import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { unprojectFrame } from './depth/grid.js';
import { getDepthFrame, liveCamera, useDepthFrameVersion } from './depth/store.js';
import { FILTER_GLSL, filterUniforms } from './filters.js';

// The camera image as a surface in the room. The latest depth frame's grid
// is lifted into the room where its view saw it, then coloured with the
// camera image as it is now, projected from where the camera is now. So
// each eye of the phone viewer sees real parallax (near things shift more
// than far ones), and colour stays live even when depth arrives a few
// frames late. A child of the XROrigin: positions are in its space.
//
// Triangles across a depth jump (neighbouring cells whose depths differ by
// more than TEAR of the nearer one) are left out: those are object edges,
// which would otherwise stretch into rubber sheets between the object and
// what's behind it. The flat camera image behind fills the gaps. A slope,
// however steep, changes depth a little per cell and stays whole.

const TEAR = 0.12;

const material = () =>
  new THREE.ShaderMaterial({
    uniforms: {
      map: { value: null },
      texel: { value: new THREE.Vector2(1 / 640, 1 / 480) },
      worldToCamera: { value: new THREE.Matrix4() },
      cameraProjection: { value: new THREE.Matrix4() },
      ...filterUniforms,
    },
    vertexShader: /* glsl */ `
      varying vec3 vOrigin; // position in XROrigin space
      void main() {
        vOrigin = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform vec2 texel;
      uniform mat4 worldToCamera;
      uniform mat4 cameraProjection;
      varying vec3 vOrigin;
      ${FILTER_GLSL}
      vec3 srgbToLinear(vec3 c) {
        return mix(c * 0.0773993808, pow(c * 0.9478672986 + 0.0521327014, vec3(2.4)), step(vec3(0.04045), c));
      }
      void main() {
        vec4 view = worldToCamera * vec4(vOrigin, 1.0);
        vec4 clip = cameraProjection * view;
        if (clip.w <= 0.0) discard;
        vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
        if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) discard; // outside the camera's view
        float depth = -view.z;
        vec3 c = applyFilter(map, uv, texel, depth, fwidth(depth) / max(depth, 1e-3));
        gl_FragColor = vec4(srgbToLinear(c), 1.0);
        #include <colorspace_fragment>
      }`,
  });

/** Triangle indices over the grid, leaving out unknown cells and triangles across depth jumps. */
function gridIndex(depth, width, height) {
  const index = [];
  const joined = (a, b) => Math.abs(depth[a] - depth[b]) < TEAR * Math.min(depth[a], depth[b]);
  const keep = (a, b, c) => depth[a] > 0 && depth[b] > 0 && depth[c] > 0 && joined(a, b) && joined(b, c) && joined(a, c);
  for (let j = 0; j < height - 1; j++) {
    for (let i = 0; i < width - 1; i++) {
      const a = j * width + i;
      const b = a + 1;
      const c = a + width;
      const d = c + 1;
      if (keep(a, c, b)) index.push(a, c, b);
      if (keep(b, c, d)) index.push(b, c, d);
    }
  }
  return index;
}

export function DepthPassthrough() {
  const version = useDepthFrameVersion();
  const mat = useMemo(material, []);
  const geometry = useMemo(() => new THREE.BufferGeometry(), []);
  useEffect(
    () => () => {
      mat.dispose();
      geometry.dispose();
    },
    [mat, geometry],
  );
  const mesh = useRef(null);

  // a new depth frame: lift its grid into the room
  useEffect(() => {
    const frame = getDepthFrame();
    if (!frame) {
      geometry.setIndex(null);
      geometry.deleteAttribute('position');
      return;
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(unprojectFrame(frame), 3));
    geometry.setIndex(gridIndex(frame.depth, frame.width, frame.height));
    geometry.computeBoundingSphere();
  }, [version, geometry]);

  // colour it with this frame's camera image
  useFrame(({ clock }) => {
    const u = mat.uniforms;
    const texture = liveCamera.texture;
    mesh.current.visible = Boolean(texture && geometry.index?.count);
    if (!texture) return;
    u.map.value = texture;
    u.worldToCamera.value.copy(liveCamera.worldToCamera);
    u.cameraProjection.value.copy(liveCamera.projection);
    u.texel.value.set(1 / liveCamera.size.x, 1 / liveCamera.size.y);
    filterUniforms.filterTime.value = clock.elapsedTime % 100;
  }, -1);

  return <mesh ref={mesh} geometry={geometry} material={mat} frustumCulled={false} visible={false} raycast={() => null} />;
}
