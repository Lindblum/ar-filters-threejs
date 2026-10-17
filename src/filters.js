// Video → Filter: effects on the camera image, run per pixel in the shaders
// that draw it (the depth passthrough, its outfill, and the motion-sensor
// camera background). The depth filters need metric depth at the pixel, so
// only the depth passthrough can show them; elsewhere they leave the image
// as it is.

export const FILTERS = [
  'none',
  'grayscale',
  'sepia',
  'invert',
  'posterize',
  'edges',
  'cartoon',
  'night',
  'thermal',
  'pixelate',
  'depthColor',
  'depthFog',
  'depthOutline',
];
export const FILTER_LABELS = {
  none: 'None',
  grayscale: 'Grayscale',
  sepia: 'Sepia',
  invert: 'Invert',
  posterize: 'Posterize',
  edges: 'Edges',
  cartoon: 'Cartoon',
  night: 'Night Vision',
  thermal: 'Thermal',
  pixelate: 'Pixelate',
  depthColor: 'Depth Colours',
  depthFog: 'Depth Fog',
  depthOutline: 'Depth Outlines',
};
export const DEPTH_FILTERS = ['depthColor', 'depthFog', 'depthOutline'];

/**
 * Shared by every material that includes FILTER_GLSL, so one assignment
 * switches them all. `filterTime` animates night vision's grain.
 */
export const filterUniforms = {
  filterId: { value: 0 },
  filterTime: { value: 0 },
};

export function setFilter(name) {
  filterUniforms.filterId.value = Math.max(0, FILTERS.indexOf(name));
}

/**
 * GLSL: vec3 applyFilter(sampler2D map, vec2 uv, vec2 texel, float depth,
 * float depthEdge). `map` is the camera image (sRGB values), `uv` where
 * this pixel samples it, `texel` one image pixel in uv. `depth`: metres to
 * the surface (< 0: unknown); `depthEdge`: how sharply depth changes here
 * (relative, per pixel). Returns sRGB.
 *
 * And vec3 filterColor(vec3 c, vec2 uv, float depth, float depthEdge): the
 * same for a colour already sampled (the blurred outfill), where filters
 * that look at neighbouring pixels fall back to their plain-colour part.
 */
export const FILTER_GLSL = /* glsl */ `
  uniform int filterId;
  uniform float filterTime;

  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

  // Sobel on luma: how strongly the image changes at uv, 0 flat to ~1 sharp
  float sobel(sampler2D map, vec2 uv, vec2 texel) {
    float tl = luma(texture2D(map, uv + texel * vec2(-1.0, 1.0)).rgb);
    float t = luma(texture2D(map, uv + texel * vec2(0.0, 1.0)).rgb);
    float tr = luma(texture2D(map, uv + texel * vec2(1.0, 1.0)).rgb);
    float l = luma(texture2D(map, uv + texel * vec2(-1.0, 0.0)).rgb);
    float r = luma(texture2D(map, uv + texel * vec2(1.0, 0.0)).rgb);
    float bl = luma(texture2D(map, uv + texel * vec2(-1.0, -1.0)).rgb);
    float b = luma(texture2D(map, uv + texel * vec2(0.0, -1.0)).rgb);
    float br = luma(texture2D(map, uv + texel * vec2(1.0, -1.0)).rgb);
    float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
    float gy = (tl + 2.0 * t + tr) - (bl + 2.0 * b + br);
    return length(vec2(gx, gy));
  }

  // Google's Turbo colour map, polynomial fit
  vec3 turbo(float x) {
    x = clamp(x, 0.0, 1.0);
    vec4 v4 = vec4(1.0, x, x * x, x * x * x);
    vec2 v2 = v4.zw * v4.z;
    return vec3(
      dot(v4, vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234)) + dot(v2, vec2(-152.94239396, 59.28637943)),
      dot(v4, vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333)) + dot(v2, vec2(4.27729857, 2.82956604)),
      dot(v4, vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771)) + dot(v2, vec2(-89.90310912, 27.34824973))
    );
  }

  // a thermal camera's "iron" palette: black, purple, red, orange, yellow, white
  vec3 ironbow(float x) {
    vec3 c = mix(vec3(0.0), vec3(0.32, 0.0, 0.5), smoothstep(0.0, 0.2, x));
    c = mix(c, vec3(0.85, 0.05, 0.2), smoothstep(0.2, 0.45, x));
    c = mix(c, vec3(1.0, 0.5, 0.0), smoothstep(0.45, 0.7, x));
    c = mix(c, vec3(1.0, 0.9, 0.15), smoothstep(0.7, 0.88, x));
    return mix(c, vec3(1.0), smoothstep(0.88, 1.0, x));
  }

  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

  vec3 filterColor(vec3 c, vec2 uv, float depth, float depthEdge) {
    if (filterId == 1) return vec3(luma(c));
    if (filterId == 2) {
      return clamp(vec3(dot(c, vec3(0.393, 0.769, 0.189)), dot(c, vec3(0.349, 0.686, 0.168)), dot(c, vec3(0.272, 0.534, 0.131))), 0.0, 1.0);
    }
    if (filterId == 3) return 1.0 - c;
    if (filterId == 4) return floor(c * 4.0 + 0.5) / 4.0;
    if (filterId == 5) return c * 0.12; // edges: the dark ground they're drawn on
    if (filterId == 6) return floor(c * 5.0 + 0.5) / 5.0; // cartoon: the flat colours
    if (filterId == 7) {
      float g = pow(luma(c), 0.6) * 1.6 + (hash(uv * 911.0 + filterTime) - 0.5) * 0.18;
      return vec3(0.15, 1.0, 0.25) * clamp(g, 0.0, 1.0);
    }
    if (filterId == 8) return ironbow(smoothstep(0.05, 0.95, luma(c)));
    if (depth < 0.0) return c; // the rest need depth
    if (filterId == 10) return turbo(1.0 - clamp(log(depth / 0.3) / log(20.0), 0.0, 1.0)); // 0.3 m red .. 6 m blue
    if (filterId == 11) return mix(c, vec3(0.78, 0.82, 0.88), 1.0 - exp(-depth * 0.45));
    if (filterId == 12) return mix(c, vec3(0.0), smoothstep(0.03, 0.12, depthEdge));
    return c;
  }

  vec3 applyFilter(sampler2D map, vec2 uv, vec2 texel, float depth, float depthEdge) {
    if (filterId == 9) {
      vec2 block = texel * 10.0;
      return texture2D(map, (floor(uv / block) + 0.5) * block).rgb;
    }
    vec3 c = texture2D(map, uv).rgb;
    if (filterId == 5) return mix(c * 0.12, vec3(0.75, 1.0, 1.0), smoothstep(0.15, 0.6, sobel(map, uv, texel)));
    if (filterId == 6) {
      vec3 flat_ = floor(c * 5.0 + 0.5) / 5.0;
      return flat_ * (1.0 - smoothstep(0.25, 0.55, sobel(map, uv, texel * 1.5)));
    }
    return filterColor(c, uv, depth, depthEdge);
  }
`;
