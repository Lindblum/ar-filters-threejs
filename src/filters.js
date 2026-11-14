// Display → Filter: effects on the camera image, run per pixel in the shaders
// that draw it (the depth passthrough, its outfill, and the motion-sensor
// camera background). Depth Colours needs metric depth at the pixel, so
// only the depth passthrough can show it; elsewhere it leaves the image
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
  'fire',
  'depthColor',
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
  fire: 'Fire',
  depthColor: 'Depth Colours',
};
export const DEPTH_FILTERS = ['depthColor'];

/**
 * Shared by every material that includes FILTER_GLSL, so one assignment
 * switches them all. `filterTime` animates night vision's grain.
 */
export const filterUniforms = {
  filterId: { value: 0 },
  filterTime: { value: 0 }, // seconds; also scrolls Fire's flames
};

export function setFilter(name) {
  filterUniforms.filterId.value = Math.max(0, FILTERS.indexOf(name));
}

// filterId values by name, from FILTERS: F_GRAYSCALE, F_DEPTH_COLOR, ...
const FILTER_DEFINES = FILTERS.map((name, i) => `#define F_${name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()} ${i}`).join('\n');

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
${FILTER_DEFINES}
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

  // smooth value noise, 0..1, and three octaves of it (0..0.875)
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float s = 0.0;
    float a = 0.5;
    for (int i = 0; i < 3; i++) {
      s += a * vnoise(p);
      p = p * 2.03 + 17.0;
      a *= 0.5;
    }
    return s;
  }

  // flame colours: black, deep red, orange, yellow, near white
  vec3 firePalette(float x) {
    vec3 c = mix(vec3(0.0), vec3(0.7, 0.04, 0.0), smoothstep(0.0, 0.3, x));
    c = mix(c, vec3(1.0, 0.38, 0.0), smoothstep(0.3, 0.6, x));
    c = mix(c, vec3(1.0, 0.82, 0.2), smoothstep(0.6, 0.85, x));
    return mix(c, vec3(1.0, 1.0, 0.85), smoothstep(0.85, 1.0, x));
  }

  // Fire's flame tongues at uv: noise rising over time (uv y is up)
  float fireNoise(vec2 uv) {
    return fbm(vec2(uv.x * 22.0, uv.y * 9.0 - filterTime * 2.2)) * 1.6;
  }

  // the scene darkened and warmed, as if lit by the flames, plus the flames
  vec3 fireLook(vec3 c, float flame) {
    vec3 lit = vec3(luma(c)) * vec3(1.0, 0.5, 0.25) * (0.75 + 0.25 * sin(filterTime * 9.0 + sin(filterTime * 23.0)));
    flame = clamp(flame, 0.0, 1.0);
    return clamp(lit * (1.0 - 0.6 * flame) + firePalette(flame), 0.0, 1.0);
  }

  // how much the image changes at uv, cheaply (three taps)
  float lumaStep(sampler2D map, vec2 uv, vec2 d) {
    float c = luma(texture2D(map, uv).rgb);
    return abs(luma(texture2D(map, uv + vec2(d.x, 0.0)).rgb) - c) + abs(luma(texture2D(map, uv + vec2(0.0, d.y)).rgb) - c);
  }

  vec3 filterColor(vec3 c, vec2 uv, float depth, float depthEdge) {
    if (filterId == F_GRAYSCALE) return vec3(luma(c));
    if (filterId == F_SEPIA) {
      return clamp(vec3(dot(c, vec3(0.393, 0.769, 0.189)), dot(c, vec3(0.349, 0.686, 0.168)), dot(c, vec3(0.272, 0.534, 0.131))), 0.0, 1.0);
    }
    if (filterId == F_INVERT) return 1.0 - c;
    if (filterId == F_POSTERIZE) return floor(c * 4.0 + 0.5) / 4.0;
    if (filterId == F_EDGES) return c * 0.12; // edges: the dark ground they're drawn on
    if (filterId == F_CARTOON) return floor(c * 5.0 + 0.5) / 5.0; // cartoon: the flat colours
    if (filterId == F_NIGHT) {
      float g = pow(luma(c), 0.6) * 1.6 + (hash(uv * 911.0 + filterTime) - 0.5) * 0.18;
      return vec3(0.15, 1.0, 0.25) * clamp(g, 0.0, 1.0);
    }
    if (filterId == F_THERMAL) return ironbow(smoothstep(0.05, 0.95, luma(c)));
    if (filterId == F_FIRE) { // no neighbours here: bright things burn
      float l = luma(c);
      return fireLook(c, l * l * fireNoise(uv));
    }
    if (depth < 0.0) return c; // the rest need depth
    if (filterId == F_DEPTH_COLOR) return turbo(1.0 - clamp(log(depth / 0.3) / log(20.0), 0.0, 1.0)); // 0.3 m red .. 6 m blue
    return c;
  }

  vec3 applyFilter(sampler2D map, vec2 uv, vec2 texel, float depth, float depthEdge) {
    vec3 c = texture2D(map, uv).rgb;
    if (filterId == F_EDGES) return mix(c * 0.12, vec3(0.75, 1.0, 1.0), smoothstep(0.15, 0.6, sobel(map, uv, texel)));
    if (filterId == F_CARTOON) {
      vec3 flat_ = floor(c * 5.0 + 0.5) / 5.0;
      return flat_ * (1.0 - smoothstep(0.25, 0.55, sobel(map, uv, texel * 1.5)));
    }
    if (filterId == F_FIRE) {
      // heat shimmer: the image wavers sideways
      vec2 suv = uv + vec2(vnoise(uv * vec2(45.0, 28.0) + vec2(0.0, -filterTime * 3.5)) - 0.5, 0.0) * 0.005;
      c = texture2D(map, suv).rgb;
      // fuel: outlines at and just below this pixel, so flames rise off every edge
      float fuel = 0.0;
      for (int i = 0; i < 5; i++) {
        float fi = float(i);
        fuel += lumaStep(map, suv - vec2(0.0, 0.011 * fi), texel * 2.0) * (1.0 - fi * 0.17);
      }
      fuel = smoothstep(0.04, 0.5, fuel);
      if (depth >= 0.0) fuel = max(fuel, smoothstep(0.02, 0.12, depthEdge)); // and off silhouettes
      float l = luma(c);
      return fireLook(c, (fuel * 1.3 + l * l * 0.5) * fireNoise(uv));
    }
    return filterColor(c, uv, depth, depthEdge);
  }
`;
