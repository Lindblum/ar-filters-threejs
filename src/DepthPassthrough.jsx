import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { getDepthFrame, liveCamera, useDepthFrameVersion } from './depth/store.js';
import { FILTER_GLSL, filterUniforms } from './filters.js';

// The camera image in the room, true to scale, drawn per pixel as the 2D-3D
// converter draws it, rather than as a mesh.
//
// The converter makes each eye's view by searching, for every output pixel,
// along the line between the eyes for the source pixel whose depth puts it
// there. Here the same search runs in 3D: each eye's ray (from wherever that
// eye is) is marched through the latest depth frame until it passes behind
// the surface, then refined by bisection. The point it reaches is coloured
// with the camera image as it is now, projected from where the camera is
// now. So there are no triangles to tear or step: edges are where the depth
// map puts them, smoothed by its filtering, and a background revealed beside
// a near object is filled from the object's edge, as in the converter.
// Parallax is real (each eye marches from its own position, at the viewer's
// eye separation), and colour stays live even when depth arrives a few frames
// late, since depth is looked up in the frame's own view, where it was seen.
// A child of the XROrigin: positions are in its space.
//
// The depth map: the frame's grid as inverse depth in a half-float texture
// (linearly filtered, so depth eases across an edge rather than stepping),
// outpainted by MARGIN beyond each edge with any unknown cells filled
// (outpaint), so moving the phone shows a surface past the last frame's edge.
//
// Where a ray misses the surface (beyond the depth, or 2D-3D off), it takes
// the dome: a sphere around the camera at the scene's typical depth
// (DOME_QUANTILE of the latest frame), a depth both eyes agree on rather than
// infinity. Beyond the camera's view, all the way round, the outfill: the
// image's edge carried outward and blurred more the further it goes (mip
// levels of a small copy of the image), so the viewer's periphery, which the
// camera never sees, has the room's colours and light instead of black. Or,
// with the outfill off (Periphery: Black), black beyond a soft edge.

const MARGIN = 0.25; // the outpainted grid's extra size beyond each edge, as a fraction of the grid
const DOME_QUANTILE = 0.75; // the dome sits behind most of the scene
const DOME_DEFAULT = 2.5; // metres, before there is any depth
const DOME_EASE = 0.1; // per frame, toward the latest depth
const OUTFILL_SIZE = 128; // the blurred copy's size: 8 mip levels
const SPHERE_RADIUS = 50; // metres: the sphere the pass is drawn on, around every eye

const VERTEX = /* glsl */ `
  uniform mat4 originFromWorld;
  varying vec3 vOrigin; // position in XROrigin space
  void main() {
    vec4 p = modelMatrix * vec4(position, 1.0);
    vOrigin = (originFromWorld * p).xyz;
    gl_Position = projectionMatrix * viewMatrix * p;
  }`;

const FRAGMENT = /* glsl */ `
  uniform sampler2D map; // the camera image now (sRGB values)
  uniform vec2 texel;
  uniform mat4 worldToCamera; // the camera now
  uniform mat4 cameraProjection;
  uniform mat4 originFromWorld;
  uniform vec3 cameraCentre; // the camera now, in XROrigin space
  uniform sampler2D outfill; // the camera image, small, with mip levels
  uniform float outfillOn; // 0: black beyond the image
  uniform float domeDepth;
  uniform float surfaceOn; // 0: 2D-3D off, everything on the dome
  uniform sampler2D depthMap; // inverse depth (1 / metres), outpainted
  uniform mat4 depthWorldToCamera; // the depth frame's view, when it was taken
  uniform mat4 depthProjection;
  uniform vec4 depthUv; // view uv to depthMap uv: xy scale, zw offset (the margin)
  varying vec3 vOrigin;
  ${FILTER_GLSL}

  const float FEATHER = 0.04; // uv inside the edge over which the sharp image fades into the outfill
  const float EDGE_LOD = 3.0; // the outfill's blur at the edge (128 px / 2^3 = 16 px across)
  const float LOD_PER_UV = 5.0; // and how fast it grows outward
  const int STEPS = 32; // samples along each ray, even in log distance (14% apart)
  const int REFINE = 6; // bisection steps once the ray has passed the surface
  const float NEAR = 0.2; // metres along the ray
  const float FAR = 15.0;

  vec3 srgbToLinear(vec3 c) {
    return mix(c * 0.0773993808, pow(c * 0.9478672986 + 0.0521327014, vec3(2.4)), step(vec3(0.04045), c));
  }

  // How far behind the surface p is, along the depth frame's view (> 0: behind),
  // or a large negative number where the frame has no depth for p.
  float behind(vec3 p) {
    vec4 q = depthWorldToCamera * vec4(p, 1.0);
    float z = -q.z;
    if (z < 1e-3) return -1e6;
    vec4 c = depthProjection * q;
    vec2 uv = (c.xy / c.w * 0.5 + 0.5) * depthUv.xy + depthUv.zw;
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return -1e6;
    float inverse = textureLod(depthMap, uv, 0.0).r;
    return inverse > 1e-4 ? z - 1.0 / inverse : -1e6;
  }

  // Where the ray from o along unit d meets the dome (a sphere of domeDepth around the camera).
  vec3 onDome(vec3 o, vec3 d) {
    vec3 oc = o - cameraCentre;
    float b = dot(oc, d);
    float disc = b * b - dot(oc, oc) + domeDepth * domeDepth;
    return o + d * (disc > 0.0 ? -b + sqrt(disc) : domeDepth);
  }

  void main() {
    vec3 eye = (originFromWorld * vec4(cameraPosition, 1.0)).xyz;
    vec3 d = normalize(vOrigin - eye);
    vec3 p = onDome(eye, d);
    bool hit = false;
    if (surfaceOn > 0.5) {
      // march out until the ray passes behind the surface, from in front of it
      float last = NEAR;
      bool inFront = false;
      for (int i = 0; i <= STEPS; i++) {
        float s = NEAR * pow(FAR / NEAR, float(i) / float(STEPS));
        float b = behind(eye + d * s);
        if (b < -1e5) {
          inFront = false;
        } else if (b < 0.0) {
          inFront = true;
          last = s;
        } else if (inFront) {
          float lo = last;
          float hi = s;
          for (int k = 0; k < REFINE; k++) {
            float mid = 0.5 * (lo + hi);
            if (behind(eye + d * mid) >= 0.0) hi = mid;
            else lo = mid;
          }
          p = eye + d * hi;
          hit = true;
          break;
        }
      }
    }

    vec3 view = (worldToCamera * vec4(p, 1.0)).xyz;
    float depth = hit ? -view.z : domeDepth;
    float depthEdge = hit ? fwidth(depth) / max(depth, 1e-3) : 0.0;
    // where it is in the camera image; behind the camera, far off the edge in its direction
    vec2 t = view.z < -1e-4 ? view.xy / -view.z : normalize(view.xy + 1e-6) * 1e3;
    vec4 clip = cameraProjection * vec4(t, -1.0, 1.0);
    vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
    vec2 edge = clamp(uv, 0.0, 1.0);
    float outside = length(uv - edge); // 0 within the image
    float inside = min(min(edge.x, 1.0 - edge.x), min(edge.y, 1.0 - edge.y));
    float lod = min(EDGE_LOD + outside * LOD_PER_UV, 7.0);
    vec3 blurred = textureLod(outfill, edge, lod).rgb * mix(1.0, 0.8, smoothstep(0.0, 1.5, outside));
    vec3 c = filterColor(blurred, edge, depth, 0.0) * outfillOn;
    if (outside == 0.0) c = mix(c, applyFilter(map, uv, texel, depth, depthEdge), smoothstep(0.0, FEATHER, inside));
    gl_FragColor = vec4(srgbToLinear(c), 1.0);
    #include <colorspace_fragment>
  }`;

const passMaterial = () =>
  new THREE.ShaderMaterial({
    uniforms: {
      map: { value: null },
      texel: { value: new THREE.Vector2(1 / 640, 1 / 480) },
      worldToCamera: { value: new THREE.Matrix4() },
      cameraProjection: { value: new THREE.Matrix4() },
      originFromWorld: { value: new THREE.Matrix4() },
      cameraCentre: { value: new THREE.Vector3() },
      outfill: { value: null },
      outfillOn: { value: 1 },
      domeDepth: { value: DOME_DEFAULT },
      surfaceOn: { value: 1 },
      depthMap: { value: null },
      depthWorldToCamera: { value: new THREE.Matrix4() },
      depthProjection: { value: new THREE.Matrix4() },
      depthUv: { value: new THREE.Vector4(1, 1, 0, 0) },
      ...filterUniforms,
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
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
      // the raw bytes (sRGB): the pass converts after filtering, as for the sharp image
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

/**
 * The grid grown by MARGIN beyond each edge, with every unknown cell (the
 * margin and any holes) filled from the known depth around it, by push-pull:
 * log depth is averaged down a pyramid of halving grids (known cells only),
 * then each unknown cell takes the coarser level's value, blended up level
 * by level. So an edge's depth carries outward and evens out with distance,
 * like the outfill's blur, at a fixed cost per frame. { depth, width,
 * height, margin }.
 */
function outpaint(depth, width, height) {
  const margin = { x: Math.round(width * MARGIN), y: Math.round(height * MARGIN) };
  const w = width + 2 * margin.x;
  const h = height + 2 * margin.y;
  // level 0: log depth and weight (1 known, 0 not)
  const value = new Float32Array(w * h);
  const weight = new Float32Array(w * h);
  for (let j = 0; j < height; j++)
    for (let i = 0; i < width; i++) {
      const d = depth[j * width + i];
      if (!(d > 0)) continue;
      const c = (j + margin.y) * w + i + margin.x;
      value[c] = Math.log(d);
      weight[c] = 1;
    }
  const levels = [{ value, weight, w, h }];
  // push: each coarser cell, the weighted mean of the 2 x 2 below it
  while (levels.at(-1).w > 1 || levels.at(-1).h > 1) {
    const f = levels.at(-1);
    const cw = Math.ceil(f.w / 2);
    const ch = Math.ceil(f.h / 2);
    const cv = new Float32Array(cw * ch);
    const cwt = new Float32Array(cw * ch);
    for (let j = 0; j < f.h; j++)
      for (let i = 0; i < f.w; i++) {
        const k = j * f.w + i;
        const c = (j >> 1) * cw + (i >> 1);
        cv[c] += f.value[k] * f.weight[k];
        cwt[c] += f.weight[k];
      }
    for (let c = 0; c < cv.length; c++) {
      if (cwt[c] > 0) cv[c] /= cwt[c];
      cwt[c] = Math.min(cwt[c], 1);
    }
    levels.push({ value: cv, weight: cwt, w: cw, h: ch });
  }
  // pull: from the coarsest up, a cell short of full weight takes the rest from the level above (bilinear)
  for (let l = levels.length - 2; l >= 0; l--) {
    const f = levels[l];
    const c = levels[l + 1];
    for (let j = 0; j < f.h; j++)
      for (let i = 0; i < f.w; i++) {
        const k = j * f.w + i;
        if (f.weight[k] >= 1) continue;
        const x = Math.min(Math.max((i + 0.5) / 2 - 0.5, 0), c.w - 1);
        const y = Math.min(Math.max((j + 0.5) / 2 - 0.5, 0), c.h - 1);
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const x1 = Math.min(x0 + 1, c.w - 1);
        const y1 = Math.min(y0 + 1, c.h - 1);
        const fx = x - x0;
        const fy = y - y0;
        const coarse =
          (c.value[y0 * c.w + x0] * (1 - fx) + c.value[y0 * c.w + x1] * fx) * (1 - fy) +
          (c.value[y1 * c.w + x0] * (1 - fx) + c.value[y1 * c.w + x1] * fx) * fy;
        f.value[k] = f.value[k] * f.weight[k] + coarse * (1 - f.weight[k]);
        f.weight[k] = 1;
      }
  }
  const out = new Float32Array(w * h);
  const known = levels.at(-1).weight[0] > 0; // anything known at all
  if (known) for (let k = 0; k < out.length; k++) out[k] = Math.exp(value[k]);
  return { depth: out, width: w, height: h, margin };
}

/**
 * The depth map for a frame: its grid outpainted (see outpaint), as inverse
 * depth in a half-float texture, rows bottom-up as GL expects, reusing
 * `texture` if it is the right size. Returns { texture, uv } with `uv` the
 * scale and offset from view uv to texture uv (the margin).
 */
function depthTexture(frame, texture) {
  const { depth, width, height, margin } = outpaint(frame.depth, frame.width, frame.height);
  let t = texture;
  if (!t || t.image.width !== width || t.image.height !== height) {
    t?.dispose();
    t = new THREE.DataTexture(new Uint16Array(width * height), width, height, THREE.RedFormat, THREE.HalfFloatType);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
  }
  const data = t.image.data;
  for (let j = 0; j < height; j++)
    for (let i = 0; i < width; i++) {
      const d = depth[j * width + i];
      data[(height - 1 - j) * width + i] = THREE.DataUtils.toHalfFloat(d > 0 ? 1 / d : 0);
    }
  t.needsUpdate = true;
  const inner = { x: width - 2 * margin.x, y: height - 2 * margin.y };
  return { texture: t, uv: new THREE.Vector4(inner.x / width, inner.y / height, margin.x / width, margin.y / height) };
}

const _matrix = new THREE.Matrix4();

/**
 * `surface`: draw the camera image at its depth; without it, flat on the
 * dome (at the scene's distance). `outfill`: fill beyond the camera's view
 * with the blurred outfill; without it, black.
 */
export function DepthPassthrough({ surface = true, outfill: outfillOn = true }) {
  const gl = useThree((s) => s.gl);
  const version = useDepthFrameVersion();
  const material = useMemo(passMaterial, []);
  const outfill = useMemo(() => new OutfillCopy(), []);
  const sphere = useMemo(() => new THREE.SphereGeometry(1, 32, 16), []);
  const depthMap = useRef(null);
  useEffect(
    () => () => {
      material.dispose();
      outfill.dispose();
      sphere.dispose();
      depthMap.current?.dispose();
    },
    [material, outfill, sphere],
  );
  const pass = useRef(null);
  const domeDepth = useRef({ target: DOME_DEFAULT, current: DOME_DEFAULT });
  const hasDepth = useRef(false);

  // a new depth frame: its depth map, and the view it was taken from
  useEffect(() => {
    const frame = getDepthFrame();
    hasDepth.current = Boolean(frame);
    if (!frame) return;
    const { texture, uv } = depthTexture(frame, depthMap.current);
    depthMap.current = texture;
    const u = material.uniforms;
    u.depthMap.value = texture;
    u.depthUv.value.copy(uv);
    u.depthWorldToCamera.value.copy(frame.worldToCamera);
    u.depthProjection.value.copy(frame.projection);
    domeDepth.current.target = depthQuantile(frame.depth, DOME_QUANTILE) ?? domeDepth.current.target;
  }, [version, material]);

  // this frame's camera image, and the sphere around the camera
  useFrame(({ clock }) => {
    const texture = liveCamera.texture;
    pass.current.visible = Boolean(texture);
    if (!texture) return;
    const u = material.uniforms;
    u.map.value = texture;
    u.worldToCamera.value.copy(liveCamera.worldToCamera);
    u.cameraProjection.value.copy(liveCamera.projection);
    u.texel.value.set(1 / liveCamera.size.x, 1 / liveCamera.size.y);
    u.surfaceOn.value = surface && hasDepth.current ? 1 : 0;
    filterUniforms.filterTime.value = clock.elapsedTime % 100;
    outfill.update(gl, texture);
    u.outfill.value = outfill.target.texture;
    u.outfillOn.value = outfillOn ? 1 : 0;

    const d = domeDepth.current;
    d.current += (d.target - d.current) * DOME_EASE;
    u.domeDepth.value = d.current;
    u.cameraCentre.value.setFromMatrixPosition(_matrix.copy(liveCamera.worldToCamera).invert());
    const parent = pass.current.parent;
    u.originFromWorld.value.copy(parent ? parent.matrixWorld : _matrix.identity()).invert();
    // a sphere around the camera, far larger than any depth, so every eye is inside it
    pass.current.position.copy(u.cameraCentre.value);
    pass.current.scale.setScalar(SPHERE_RADIUS);
  }, -1);

  // drawn first, ignoring depth, so anything virtual draws over it
  return (
    <mesh
      ref={pass}
      geometry={sphere}
      material={material}
      renderOrder={-500}
      frustumCulled={false}
      visible={false}
      raycast={() => null}
    />
  );
}
