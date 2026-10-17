import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { unprojectFrame } from './depth/grid.js';
import { getDepthFrame, liveCamera, useDepthFrameVersion } from './depth/store.js';
import { FILTER_GLSL, filterUniforms } from './filters.js';

// The camera image in the room, true to scale.
//
// The surface: the latest depth frame's grid lifted into the room where its
// view saw it, then coloured with the camera image as it is now, projected
// from where the camera is now. So each eye of the phone viewer sees real
// parallax (near things shift more than far ones), and colour stays live
// even when depth arrives a few frames late. A child of the XROrigin:
// positions are in its space.
//
// Triangles across a depth jump (neighbouring cells whose depths differ by
// more than TEAR of the nearer one) are left out: those are object edges,
// which would otherwise stretch into rubber sheets between the object and
// what's behind it. A slope, however steep, changes depth a little per cell
// and stays whole.
//
// The dome: a sphere around the camera at the scene's typical depth
// (DOME_QUANTILE of the latest frame), behind everything. Where the camera
// can see, it shows the live image at true scale; that fills the surface's
// tears, at a depth both eyes agree on rather than at infinity. Everywhere
// else, all the way round, it shows the outfill: the image's edge carried
// outward and blurred more the further it goes (mip levels of a small copy
// of the image), so the viewer's periphery, which the camera never sees,
// has the room's colours and light instead of black. Or, with the outfill
// off (Periphery: Black), black beyond a soft edge.

const TEAR = 0.12;
const DOME_QUANTILE = 0.75; // the dome sits behind most of the scene
const DOME_DEFAULT = 2.5; // metres, before there is any depth
const DOME_EASE = 0.1; // per frame, toward the latest depth
const OUTFILL_SIZE = 128; // the blurred copy's size: 8 mip levels

const VERTEX = /* glsl */ `
  varying vec3 vOrigin; // position in XROrigin space
  void main() {
    vec4 p = modelMatrix * vec4(position, 1.0);
    vOrigin = p.xyz;
    gl_Position = projectionMatrix * viewMatrix * p;
  }`;

const HEADER = /* glsl */ `
  uniform sampler2D map;
  uniform vec2 texel;
  uniform mat4 worldToCamera;
  uniform mat4 cameraProjection;
  varying vec3 vOrigin;
  ${FILTER_GLSL}
  vec3 srgbToLinear(vec3 c) {
    return mix(c * 0.0773993808, pow(c * 0.9478672986 + 0.0521327014, vec3(2.4)), step(vec3(0.04045), c));
  }`;

const uniforms = () => ({
  map: { value: null },
  texel: { value: new THREE.Vector2(1 / 640, 1 / 480) },
  worldToCamera: { value: new THREE.Matrix4() },
  cameraProjection: { value: new THREE.Matrix4() },
  ...filterUniforms,
});

const surfaceMaterial = () =>
  new THREE.ShaderMaterial({
    uniforms: uniforms(),
    vertexShader: VERTEX,
    fragmentShader: /* glsl */ `
      ${HEADER}
      void main() {
        vec4 view = worldToCamera * vec4(vOrigin, 1.0);
        vec4 clip = cameraProjection * view;
        if (clip.w <= 0.0) discard;
        vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
        if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) discard; // the dome draws there
        float depth = -view.z;
        vec3 c = applyFilter(map, uv, texel, depth, fwidth(depth) / max(depth, 1e-3));
        gl_FragColor = vec4(srgbToLinear(c), 1.0);
        #include <colorspace_fragment>
      }`,
  });

const domeMaterial = () =>
  new THREE.ShaderMaterial({
    uniforms: { ...uniforms(), outfill: { value: null }, outfillOn: { value: 1 }, domeDepth: { value: DOME_DEFAULT } },
    vertexShader: VERTEX,
    fragmentShader: /* glsl */ `
      ${HEADER}
      uniform sampler2D outfill; // the camera image, small, with mip levels
      uniform float outfillOn; // 0: black beyond the image
      uniform float domeDepth;
      const float FEATHER = 0.04; // uv inside the edge over which the sharp image fades into the outfill
      const float EDGE_LOD = 3.0; // the outfill's blur at the edge (128 px / 2^3 = 16 px across)
      const float LOD_PER_UV = 5.0; // and how fast it grows outward
      void main() {
        vec3 dir = (worldToCamera * vec4(vOrigin, 1.0)).xyz;
        // where this direction meets the image plane; behind the camera, far off the edge in its direction
        vec2 t = dir.z < -1e-4 ? dir.xy / -dir.z : normalize(dir.xy + 1e-6) * 1e3;
        vec4 clip = cameraProjection * vec4(t, -1.0, 1.0);
        vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
        vec2 edge = clamp(uv, 0.0, 1.0);
        float outside = length(uv - edge); // 0 within the image
        float inside = min(min(edge.x, 1.0 - edge.x), min(edge.y, 1.0 - edge.y));
        float lod = min(EDGE_LOD + outside * LOD_PER_UV, 7.0);
        vec3 blurred = textureLod(outfill, edge, lod).rgb * mix(1.0, 0.8, smoothstep(0.0, 1.5, outside));
        vec3 c = filterColor(blurred, edge, domeDepth, 0.0) * outfillOn;
        if (outside == 0.0) c = mix(c, applyFilter(map, uv, texel, domeDepth, 0.0), smoothstep(0.0, FEATHER, inside));
        gl_FragColor = vec4(srgbToLinear(c), 1.0);
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
  });

/** Copies the camera image into a small target with mip levels, for the outfill's blur. */
class OutfillCopy {
  constructor() {
    this.target = new THREE.WebGLRenderTarget(OUTFILL_SIZE, OUTFILL_SIZE, {
      depthBuffer: false,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.material = new THREE.ShaderMaterial({
      uniforms: { map: { value: null } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      // the raw bytes (sRGB): the dome converts after filtering, as for the sharp image
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        varying vec2 vUv;
        void main() { gl_FragColor = vec4(texture2D(map, vUv).rgb, 1.0); }`,
      depthTest: false,
      depthWrite: false,
    });
    this.scene = new THREE.Scene();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  update(gl, texture) {
    this.material.uniforms.map.value = texture;
    const previous = gl.getRenderTarget();
    const xrEnabled = gl.xr.enabled;
    gl.xr.enabled = false; // a plain pass: keep three from substituting the XR camera
    gl.setRenderTarget(this.target);
    gl.render(this.scene, this.camera);
    gl.setRenderTarget(previous);
    gl.xr.enabled = xrEnabled;
    this.material.uniforms.map.value = null;
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}

/** The depth that `q` of a frame's known cells are nearer than, or null if none are known. */
function depthQuantile(depth, q) {
  const known = depth.filter((d) => d > 0).sort();
  return known.length ? known[Math.min(known.length - 1, Math.floor(q * known.length))] : null;
}

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

const _toWorld = new THREE.Matrix4();

/**
 * `surface`: draw the camera image at its depth; without it, only the dome
 * (flat at the scene's distance). `outfill`: fill beyond the camera's view
 * with the blurred outfill; without it, black.
 */
export function DepthPassthrough({ surface = true, outfill: outfillOn = true }) {
  const gl = useThree((s) => s.gl);
  const version = useDepthFrameVersion();
  const mat = useMemo(surfaceMaterial, []);
  const domeMat = useMemo(domeMaterial, []);
  const outfill = useMemo(() => new OutfillCopy(), []);
  const geometry = useMemo(() => new THREE.BufferGeometry(), []);
  const domeGeometry = useMemo(() => new THREE.SphereGeometry(1, 48, 24), []);
  useEffect(
    () => () => {
      mat.dispose();
      domeMat.dispose();
      outfill.dispose();
      geometry.dispose();
      domeGeometry.dispose();
    },
    [mat, domeMat, outfill, geometry, domeGeometry],
  );
  const mesh = useRef(null);
  const dome = useRef(null);
  const domeDepth = useRef({ target: DOME_DEFAULT, current: DOME_DEFAULT });

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
    domeDepth.current.target = depthQuantile(frame.depth, DOME_QUANTILE) ?? domeDepth.current.target;
  }, [version, geometry]);

  // colour both with this frame's camera image, and centre the dome on the camera
  useFrame(({ clock }) => {
    const texture = liveCamera.texture;
    mesh.current.visible = Boolean(surface && texture && geometry.index?.count);
    dome.current.visible = Boolean(texture);
    if (!texture) return;
    for (const { uniforms: u } of [mat, domeMat]) {
      u.map.value = texture;
      u.worldToCamera.value.copy(liveCamera.worldToCamera);
      u.cameraProjection.value.copy(liveCamera.projection);
      u.texel.value.set(1 / liveCamera.size.x, 1 / liveCamera.size.y);
    }
    filterUniforms.filterTime.value = clock.elapsedTime % 100;
    outfill.update(gl, texture);
    domeMat.uniforms.outfill.value = outfill.target.texture;
    domeMat.uniforms.outfillOn.value = outfillOn ? 1 : 0;

    const d = domeDepth.current;
    d.current += (d.target - d.current) * DOME_EASE;
    domeMat.uniforms.domeDepth.value = d.current;
    dome.current.position.setFromMatrixPosition(_toWorld.copy(liveCamera.worldToCamera).invert());
    dome.current.scale.setScalar(d.current);
  }, -1);

  return (
    <>
      {/* drawn first, ignoring depth, so the surface and anything virtual draw over it */}
      <mesh
        ref={dome}
        geometry={domeGeometry}
        material={domeMat}
        renderOrder={-500}
        frustumCulled={false}
        visible={false}
        raycast={() => null}
      />
      <mesh ref={mesh} geometry={geometry} material={mat} frustumCulled={false} visible={false} raycast={() => null} />
    </>
  );
}
