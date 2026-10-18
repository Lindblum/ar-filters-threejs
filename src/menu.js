// Options menu model shared by the windowed panel (DOM) and the XR panel
// (drawn on a canvas): one list of buttons, each "Name: Value". A button
// toggles or cycles its setting, runs an action, opens a section (its
// settings indented beneath it), or opens a dropdown list of choices
// beneath it. Sections and dropdowns show a chevron on the right. A slider
// sets a number along its track instead.

import { FILTERS, FILTER_LABELS } from './filters.js';

export const MENU_TITLE = 'Depth XR';

/** Video → Background, in list order (passthrough, then the desktop's test feed, last). */
export const BACKGROUNDS = ['solid', 'skybox', 'passthrough', 'testFeed'];
const BACKGROUND_LABELS = {
  solid: 'Solid',
  skybox: 'Skybox',
  passthrough: 'Passthrough (XR Only)',
  testFeed: 'Test Feed (Webcam)',
};
const BACKGROUND_ICONS = { solid: 'solid', skybox: 'skybox', passthrough: 'passthrough', testFeed: 'camera' };

/** The Vite + React starter's page colour, used for the Solid background, as in the 4D viewer. */
export const SOLID_BACKGROUND = '#242424';


/**
 * View Mode, in list order. Normal, 3D: SBS (half side-by-side, for 3D
 * TVs and projectors) and 3D: Interlaced (alternate rows, for passive 3D
 * monitors) are windowed. The rest are XR: XR: Headset on headsets; on
 * phones, XR: Phone AR (one view) and XR: Phone Viewer (two lens-corrected
 * eyes for a phone viewer), as in the 4D viewer.
 */
export const VIEWS = ['normal', 'sbs', 'interlaced', 'xr', 'phoneAR', 'phoneViewer'];
export const XR_VIEWS = ['xr', 'phoneAR', 'phoneViewer'];
const VIEW_LABELS = {
  normal: 'Normal',
  sbs: '3D: SBS',
  interlaced: '3D: Interlaced',
  xr: 'XR: Headset',
  phoneAR: 'XR: Phone AR',
  phoneViewer: 'XR: Phone Viewer',
};
const VIEW_ICONS = {
  normal: 'monitor',
  sbs: 'monitorSbs',
  interlaced: 'monitorInterlaced',
  xr: 'vr',
  phoneAR: 'phone',
  phoneViewer: 'phoneViewer',
};
const STEREO_VIEWS = ['sbs', 'interlaced'];

/**
 * The views this device can show. `env`: { phone, headset, xrSupported }. A
 * headset browser's own window can't show screen stereo usefully, so no SBS
 * or Interlaced there. Phones always get their XR views: without WebXR AR
 * they fall back to the motion sensors.
 */
export function availableViews(env) {
  return VIEWS.filter((view) => {
    if (STEREO_VIEWS.includes(view)) return !env.headset;
    if (view === 'xr') return !env.phone && env.xrSupported;
    if (view === 'phoneAR' || view === 'phoneViewer') return env.phone;
    return true;
  });
}

/**
 * Why this device can't use a Background or View Mode choice, or null if it
 * can. Unavailable choices still show in their lists, disabled, with this
 * as their tooltip. Passthrough needs AR; the test feed is desktop only (it
 * stands in for a phone's camera); views as availableViews.
 */
export function unavailableReason(env, dropdownId, choice) {
  if (dropdownId === 'background') {
    if (choice === 'passthrough' && !env.passthroughAvailable) return 'Needs an AR-capable headset or a phone camera';
    if (choice === 'testFeed' && !env.testFeedAvailable) return 'Desktop only: it stands in for a phone camera';
    return null;
  }
  if (dropdownId !== 'view' || (env.views ?? ['normal']).includes(choice)) return null;
  if (STEREO_VIEWS.includes(choice)) return "Not on a headset: its browser window can't show screen 3D";
  if (choice === 'xr') {
    if (env.phone) return 'On a phone, use XR: Phone AR or XR: Phone Viewer';
    return env.checking ? 'Checking for WebXR…' : "WebXR isn't available here. Open the page in a headset browser over HTTPS";
  }
  return 'Needs an Android phone';
}

/** The item after `current` in `list`, wrapping around; `step` -1 goes back. */
export const cycle = (list, current, step = 1) => list[(list.indexOf(current) + step + list.length) % list.length];

/**
 * A label's setting name and its value, split at the first ": ". The panels
 * draw the name on the left and the value against the right edge.
 */
export function splitLabel(label) {
  const at = label.indexOf(': ');
  return at < 0 ? { name: label, value: '' } : { name: label.slice(0, at), value: label.slice(at + 2) };
}

/** Sections: each button opens or closes its settings, indented beneath it. */
export const SECTIONS = ['depth', 'video'];
export const SECTION_PREFIX = 'section:';

export const PICK_PREFIX = 'pick:';
/** A slider's new value: "set:<id>:<value>". */
export const SET_PREFIX = 'set:';

/**
 * A dropdown: the button shows the current choice, and when it is the open
 * one (`state.dropdown`), lists every choice beneath it, each with
 * `icons[i]` if given. A choice with a reason in `unavailable[i]` shows
 * disabled, the reason its tooltip. Choosing one sends "pick:<id>:<index>".
 */
function dropdown(state, id, choices, current, icons, unavailable) {
  return {
    open: state.dropdown === id,
    options: choices.map((label, i) => ({
      id: `${PICK_PREFIX}${id}:${i}`,
      label,
      icon: icons?.[i],
      selected: i === current,
      disabled: Boolean(unavailable?.[i]),
      title: unavailable?.[i] ?? undefined,
    })),
  };
}

/** Depth → Algorithm: how depth is made (see depth/DepthSource.jsx). */
export const DEPTH_MODES = ['auto', 'arcore', 'da2', 'da3', 'midas', 'heuristic', 'ground', 'parallax'];
export const DEPTH_MODE_LABELS = {
  auto: 'Auto',
  arcore: 'ARCore',
  da2: 'Depth Anything V2',
  da3: 'Depth Anything V3',
  midas: 'MiDaS',
  heuristic: 'Heuristic',
  ground: 'Ground Plane',
  parallax: 'Motion Parallax',
};

/** A slider's value from a fraction 0..1 along its track, snapped to its step. */
export function sliderValue({ min, max, step }, t) {
  const v = min + Math.round((Math.min(Math.max(t, 0), 1) * (max - min)) / step) * step;
  return Number(v.toFixed(6));
}

/** Every value a slider can take, for possibleLabels. */
function sliderValues(spec) {
  const steps = Math.round((spec.max - spec.min) / spec.step);
  return Array.from({ length: steps + 1 }, (_, i) => sliderValue(spec, i / steps));
}

/** Depth → 3D Strength: the eyes' separation, times true scale. */
export const STRENGTH = { min: 0, max: 3, step: 0.25 };
const strengthLabel = (s) => `${s}×`;

/**
 * Depth → Convergence: the distance the phone viewer's eyes meet at, in
 * dioptres (1 / metres), so the slider is even in disparity. 0 (∞) is true
 * to life: the eyes parallel, as the viewer's lenses expect.
 */
export const CONVERGENCE = { min: 0, max: 2, step: 0.1 };
const convergenceLabel = (d) => (d > 0 ? `${Number((1 / d).toPrecision(2))} m` : '∞');

/** Depth → Smoothing: how much of the past is averaged into each depth frame, 0..1 (see depth/smooth.js). */
export const SMOOTHING = { min: 0, max: 1, step: 0.05 };
const smoothingLabel = (s) => (s > 0 ? `${Math.round(s * 100)}%` : 'Off');

/**
 * Video → Periphery: what the phone viewer shows beyond the camera's view,
 * which is narrower than the lenses': Black, the blurred Outfill, or the
 * image Stretched (magnified) to fill the viewer.
 */
export const PERIPHERIES = ['black', 'outfill', 'stretch'];
const PERIPHERY_LABELS = { black: 'Black', outfill: 'Outfill', stretch: 'Stretch' };

/** The dropdowns' ids. */
export const DROPDOWNS = ['depthMode', 'filter', 'periphery', 'background', 'view'];

/** The on / off settings, by button id. */
export const TOGGLES = ['depthMesh'];

/** The sliders' ids. */
export const SLIDERS = ['convergence', 'smoothing', 'strength'];

/** One-shot actions, by button id. */
export const ACTIONS = [];

/**
 * The choices behind each dropdown, in list order, including any this device
 * can't use (see unavailableReason). App applies a pick ("pick:<id>:<index>")
 * by its index into these.
 */
export function dropdownChoices() {
  return {
    depthMode: DEPTH_MODES,
    periphery: PERIPHERIES,
    filter: FILTERS,
    background: BACKGROUNDS,
    view: VIEWS,
  };
}

const onOff = (on) => (on ? 'On' : 'Off');

function depthItems(state) {
  return [
    {
      id: 'depthMesh',
      label: `2D-3D: ${onOff(state.depthMesh)}`,
      icon: 'mesh',
      title: "Turns the camera image into 3D from its depth. Off: the image flat, at the scene's typical distance",
    },
    {
      id: 'depthMode',
      label: `Algorithm: ${DEPTH_MODE_LABELS[state.depthMode]}`,
      icon: 'algorithm',
      title:
        'Auto: ARCore depth, sharpened by Depth Anything V2 while it keeps up. The models download once (V2 50 MB, V3 105 MB, MiDaS 66 MB). Heuristic and Ground Plane are instant guesses; Motion Parallax triangulates as you move the phone',
      dropdown: dropdown(state, 'depthMode', DEPTH_MODES.map((m) => DEPTH_MODE_LABELS[m]), DEPTH_MODES.indexOf(state.depthMode)),
    },
    {
      id: 'convergence',
      label: `Convergence: ${convergenceLabel(state.convergence)}`,
      icon: 'convergence',
      title:
        'Where the eyes meet in the phone viewer: ∞ is true to life; nearer brings close things to a comfortable focus but puts the distance out of reach',
      slider: { ...CONVERGENCE, value: state.convergence },
    },
    {
      id: 'smoothing',
      label: `Smoothing: ${smoothingLabel(state.smoothing)}`,
      icon: 'smoothing',
      title: 'Averages depth over recent frames to steady it; a real change (something moving) comes through at once',
      slider: { ...SMOOTHING, value: state.smoothing },
    },
    {
      id: 'strength',
      label: `3D Strength: ${strengthLabel(state.strength)}`,
      icon: 'eye',
      title: "The eyes' separation in the phone viewer: 1× is true to scale, more exaggerates depth",
      slider: { ...STRENGTH, value: state.strength },
    },
  ];
}

function videoItems(state, env) {
  return [
    {
      id: 'filter',
      label: `Filter: ${FILTER_LABELS[state.filter]}`,
      icon: 'filter',
      title: 'Depth filters need depth: the depth passthrough, in XR or on the test feed',
      dropdown: dropdown(state, 'filter', FILTERS.map((f) => FILTER_LABELS[f]), FILTERS.indexOf(state.filter)),
    },
    {
      id: 'periphery',
      label: `Periphery: ${PERIPHERY_LABELS[state.periphery]}`,
      icon: 'phoneViewer',
      title:
        "The phone viewer beyond the camera's narrower view. Black; Outfill: the image's edges carried out, blurred; Stretch: the image magnified to fill (turning moves it a little fast)",
      dropdown: dropdown(state, 'periphery', PERIPHERIES.map((p) => PERIPHERY_LABELS[p]), PERIPHERIES.indexOf(state.periphery)),
    },
    {
      id: 'background',
      label: `Background: ${BACKGROUND_LABELS[state.background]}`,
      icon: BACKGROUND_ICONS[state.background],
      dropdown: dropdown(
        state,
        'background',
        BACKGROUNDS.map((b) => BACKGROUND_LABELS[b]),
        BACKGROUNDS.indexOf(state.background),
        BACKGROUNDS.map((b) => BACKGROUND_ICONS[b]),
        BACKGROUNDS.map((b) => unavailableReason(env, 'background', b)),
      ),
    },
    {
      id: 'view',
      label: `View Mode: ${VIEW_LABELS[state.view]}`,
      icon: VIEW_ICONS[state.view],
      dropdown: dropdown(
        state,
        'view',
        VIEWS.map((v) => VIEW_LABELS[v]),
        VIEWS.indexOf(state.view),
        VIEWS.map((v) => VIEW_ICONS[v]),
        VIEWS.map((v) => unavailableReason(env, 'view', v)),
      ),
    },
  ];
}

const SECTION_ITEMS = { depth: depthItems, video: videoItems };
const SECTION_LABELS = { depth: 'Depth', video: 'Video' };
const SECTION_ICONS = { depth: 'layers', video: 'video' };

/**
 * The buttons. Items: { id, label ("Name: Value", see splitLabel), icon,
 * disabled?, title?, section?, dropdown?, slider?, indent? }. `slider`:
 * { min, max, step, value }, its track between the name and the value;
 * moving it sends "set:<id>:<value>". `section`: { open },
 * a section's button ("section:<id>"), drawn with a chevron at the far
 * right; when open (in `state.sections`), its settings follow it with
 * `indent: true`. `dropdown`: { open, options: [{ id, label, selected }] },
 * drawn with a chevron at the far right and, when open, its options
 * beneath. `env`: { xrSupported, passthroughAvailable, testFeedAvailable,
 * checking, phone, views (available) }.
 */
export function menuItems(state, env) {
  const items = [];
  for (const id of SECTIONS) {
    const open = state.sections.includes(id);
    items.push({ id: `${SECTION_PREFIX}${id}`, label: SECTION_LABELS[id], icon: SECTION_ICONS[id], section: { open } });
    if (open) items.push(...SECTION_ITEMS[id](state, env).map((item) => ({ ...item, indent: true })));
  }
  return items;
}

/** The most buttons the menu can show (every section open), so the XR panel can keep its top edge still as sections open and close. */
const SAMPLE_STATE = {
  depthMode: DEPTH_MODES[0],
  smoothing: 0.5,
  convergence: 0,
  strength: 1,
  periphery: PERIPHERIES[1],
  filter: FILTERS[0],
  background: 'solid',
  view: 'normal',
  sections: SECTIONS,
};
export const MENU_ROWS = menuItems(SAMPLE_STATE, {}).length;

/**
 * Every label the buttons can show, in every section, so both panels can size
 * themselves to the widest one and not change width as values change. (The
 * dropdowns' choices sit two to a row in less room, so they don't set it.)
 */
export function possibleLabels(env) {
  const labels = new Set();
  const base = { ...SAMPLE_STATE, depthMesh: true };
  const variants = [
    ...DEPTH_MODES.map((depthMode) => ({ depthMode })),
    ...sliderValues(STRENGTH).map((strength) => ({ strength })),
    ...sliderValues(CONVERGENCE).map((convergence) => ({ convergence })),
    ...sliderValues(SMOOTHING).map((smoothing) => ({ smoothing })),
    ...PERIPHERIES.map((periphery) => ({ periphery })),
    ...FILTERS.map((filter) => ({ filter })),
    ...BACKGROUNDS.map((background) => ({ background })),
    ...VIEWS.map((view) => ({ view })),
    { depthMesh: false },
  ];
  for (const v of variants) for (const item of menuItems({ ...base, ...v }, env)) labels.add(item.label);
  return [...labels];
}
