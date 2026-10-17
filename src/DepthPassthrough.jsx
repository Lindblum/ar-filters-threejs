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
// Behind it, the same live image at true scale on a plane across the
// camera's view, at the scene's typical depth (BACKDROP_QUANTILE of the
// latest frame), fills the tears and the cells with no depth. Both eyes see
// it at that depth, so the gaps don't pull the eyes out to infinity.
//
// Triangles across a depth jump (neighbouring cells whose depths differ by
// more than TEAR of the nearer one) are left out: those are object edges,
// which would otherwise stretch into rubber sheets between the object and
// what's behind it. The backdrop fills the gaps. A slope,
// however steep, changes depth a little per cell and stays whole.

const TEAR = 0.12;
const BACKDROP_QUANTILE = 0.75; // the backdrop sits behind most of the scene
const BACKDROP_DEFAULT = 2.5; // metres, before there is any depth
const BACKDROP_EASE = 0.1; // per frame, toward the latest depth

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

/** The depth that `q` of a frame's known cells are nearer than, or null if none are known. */
function depthQuantile(depth, q) {
  const known = depth.filter((d) => d > 0).sort();
  return known.length ? known[Math.min(known.length - 1, Math.floor(q * known.length))] : null;
}

const _toWorld = new THREE.Matrix4();
const _unproject = new THREE.Matrix4();
const _corner = new THREE.Vector4();
const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

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
  const backdropMat = useMemo(() => Object.assign(material(), { depthTest: false, depthWrite: false }), []);
  const geometry = useMemo(() => new THREE.BufferGeometry(), []);
  const backdropGeometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    return g;
  }, []);
  useEffect(
    () => () => {
      mat.dispose();
      backdropMat.dispose();
      geometry.dispose();
      backdropGeometry.dispose();
    },
    [mat, backdropMat, geometry, backdropGeometry],
  );
  const mesh = useRef(null);
  const backdrop = useRef(null);
  const backdropDepth = useRef({ target: BACKDROP_DEFAULT, current: BACKDROP_DEFAULT });

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
    backdropDepth.current.target = depthQuantile(frame.depth, BACKDROP_QUANTILE) ?? backdropDepth.current.target;
  }, [version, geometry]);

  // colour both with this frame's camera image, and set the backdrop across the camera's view
  useFrame(({ clock }) => {
    const texture = liveCamera.texture;
    mesh.current.visible = Boolean(texture && geometry.index?.count);
    backdrop.current.visible = Boolean(texture);
    if (!texture) return;
    for (const { uniforms: u } of [mat, backdropMat]) {
      u.map.value = texture;
      u.worldToCamera.value.copy(liveCamera.worldToCamera);
      u.cameraProjection.value.copy(liveCamera.projection);
      u.texel.value.set(1 / liveCamera.size.x, 1 / liveCamera.size.y);
    }
    filterUniforms.filterTime.value = clock.elapsedTime % 100;

    const d = backdropDepth.current;
    d.current += (d.target - d.current) * BACKDROP_EASE;
    _toWorld.copy(liveCamera.worldToCamera).invert();
    _unproject.copy(liveCamera.projection).invert();
    const position = backdropGeometry.attributes.position;
    CORNERS.forEach(([x, y], i) => {
      // a little past the view's edge, so no seam shows; the shader trims it
      _corner.set(x * 1.02, y * 1.02, 0.5, 1).applyMatrix4(_unproject);
      _corner.multiplyScalar(d.current / (-_corner.z / _corner.w) / _corner.w);
      _corner.w = 1;
      _corner.applyMatrix4(_toWorld);
      position.setXYZ(i, _corner.x, _corner.y, _corner.z);
    });
    position.needsUpdate = true;
  }, -1);

  return (
    <>
      {/* drawn first, ignoring depth, so the surface and anything virtual draw over it */}
      <mesh
        ref={backdrop}
        geometry={backdropGeometry}
        material={backdropMat}
        renderOrder={-500}
        frustumCulled={false}
        visible={false}
        raycast={() => null}
      />
      <mesh ref={mesh} geometry={geometry} material={mat} frustumCulled={false} visible={false} raycast={() => null} />
    </>
  );
}
