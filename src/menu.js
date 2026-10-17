// Options menu model shared by the windowed panel (DOM) and the XR panel
// (drawn on a canvas): one list of buttons, each "Name: Value". A button
// toggles or cycles its setting, runs an action, opens a submenu (an arrow
// on its right), or opens a dropdown list of choices beneath it (a chevron
// on its right).

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
 * The backgrounds this device can show: passthrough only where there is
 * AR, the test feed only on desktops (it stands in for a phone's camera).
 */
export const availableBackgrounds = (env) =>
  BACKGROUNDS.filter((b) => (b === 'passthrough' ? env.passthroughAvailable : b === 'testFeed' ? env.testFeedAvailable : true));

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

/** Submenus. The top page links to each; each starts with a Back button. */
export const PAGES = ['main', 'depth', 'video'];
const PAGE_TITLES = { main: MENU_TITLE, depth: 'Depth', video: 'Video' };
export const PAGE_PREFIX = 'page:';

export const menuTitle = (page) => PAGE_TITLES[page];

export const PICK_PREFIX = 'pick:';

/**
 * A dropdown: the button shows the current choice, and when it is the open
 * one (`state.dropdown`), lists every choice beneath it, each with
 * `icons[i]` if given. Choosing one sends "pick:<id>:<index>".
 */
function dropdown(state, id, choices, current, icons) {
  return {
    open: state.dropdown === id,
    options: choices.map((label, i) => ({ id: `${PICK_PREFIX}${id}:${i}`, label, icon: icons?.[i], selected: i === current })),
  };
}

/** Depth → Source: where depth comes from (see depth/DepthSource.jsx). */
export const DEPTH_MODES = ['auto', 'arcore', 'ml', 'off'];
const DEPTH_MODE_LABELS = { auto: 'Auto', arcore: 'ARCore', ml: 'ML Model', off: 'Off' };

/** Depth → Stereo Strength: the eyes' separation, times true scale. */
export const STRENGTHS = [0, 0.5, 1, 1.5, 2, 3];
const strengthLabel = (s) => `${s}×`;

/**
 * Depth → Field of View in the phone viewer: Fill magnifies both eyes alike
 * until the camera image fills them; True keeps everything to scale, which
 * leaves the camera's narrower view as a window in the middle.
 */
export const FOVS = ['fill', 'true'];
const FOV_LABELS = { fill: 'Fill', true: 'True' };

/** The dropdowns' ids. */
export const DROPDOWNS = ['depthMode', 'strength', 'fov', 'filter', 'background', 'view'];

/** The on / off settings, by button id. */
export const TOGGLES = ['depthMesh'];

/** One-shot actions, by button id. */
export const ACTIONS = [];

/**
 * The choices behind each dropdown on this device, in list order. App
 * applies a pick ("pick:<id>:<index>") by its index into these.
 */
export function dropdownChoices(env) {
  return {
    depthMode: DEPTH_MODES,
    strength: STRENGTHS,
    fov: FOVS,
    filter: FILTERS,
    background: availableBackgrounds(env),
    view: env.views ?? ['normal'],
  };
}

const onOff = (on) => (on ? 'On' : 'Off');

function depthItems(state) {
  return [
    {
      id: 'depthMode',
      label: `Source: ${DEPTH_MODE_LABELS[state.depthMode]}`,
      icon: 'camera',
      title: 'Auto: ARCore depth where the phone has it, sharpened by the ML model while it keeps up',
      dropdown: dropdown(state, 'depthMode', DEPTH_MODES.map((m) => DEPTH_MODE_LABELS[m]), DEPTH_MODES.indexOf(state.depthMode)),
    },
    {
      id: 'depthMesh',
      label: `Depth Passthrough: ${onOff(state.depthMesh)}`,
      icon: 'mesh',
      title: 'Off: the camera image flat behind everything, as before',
    },
    {
      id: 'strength',
      label: `Stereo Strength: ${strengthLabel(state.strength)}`,
      icon: 'eye',
      title: "The eyes' separation in the phone viewer: 1× is true to scale, more exaggerates depth",
      dropdown: dropdown(state, 'strength', STRENGTHS.map(strengthLabel), STRENGTHS.indexOf(state.strength)),
    },
    {
      id: 'fov',
      label: `Field of View: ${FOV_LABELS[state.fov]}`,
      icon: 'phoneViewer',
      title: "Fill: the camera image fills the viewer, magnified (turning moves it a little fast). True: exact scale, the camera's view a window in the middle",
      dropdown: dropdown(state, 'fov', FOVS.map((f) => FOV_LABELS[f]), FOVS.indexOf(state.fov)),
    },
  ];
}

function videoItems(state, env) {
  const backgrounds = availableBackgrounds(env);
  const views = env.views ?? ['normal'];
  return [
    {
      id: 'filter',
      label: `Filter: ${FILTER_LABELS[state.filter]}`,
      icon: 'filter',
      title: 'Depth filters need depth: the depth passthrough, in XR or on the test feed',
      dropdown: dropdown(state, 'filter', FILTERS.map((f) => FILTER_LABELS[f]), FILTERS.indexOf(state.filter)),
    },
    {
      id: 'background',
      label: `Background: ${BACKGROUND_LABELS[state.background]}`,
      icon: BACKGROUND_ICONS[state.background],
      title: env.passthroughAvailable ? undefined : 'Passthrough needs an AR-capable headset or a phone camera',
      dropdown: dropdown(
        state,
        'background',
        backgrounds.map((b) => BACKGROUND_LABELS[b]),
        backgrounds.indexOf(state.background),
        backgrounds.map((b) => BACKGROUND_ICONS[b]),
      ),
    },
    {
      id: 'view',
      label: `View Mode: ${VIEW_LABELS[state.view]}`,
      icon: VIEW_ICONS[state.view],
      dropdown: dropdown(
        state,
        'view',
        views.map((v) => VIEW_LABELS[v]),
        views.indexOf(state.view),
        views.map((v) => VIEW_ICONS[v]),
      ),
      disabled: views.length < 2,
      title:
        !env.xrSupported && !env.checking
          ? "WebXR isn't available here. Open the page in a headset browser over HTTPS for XR."
          : undefined,
    },
  ];
}

const BACK = { id: `${PAGE_PREFIX}main`, label: 'Back', icon: 'back' };

/**
 * The buttons on `state.page`. Items: { id, label ("Name: Value", see
 * splitLabel), icon, disabled?, title?, submenu?, dropdown? }. `submenu`:
 * the id ("page:<page>") opens that page, drawn with an arrow at the far
 * right. `dropdown`: { open, options: [{ id, label, selected }] }, drawn
 * with a chevron at the far right and, when open, its options beneath.
 * `env`: { xrSupported, passthroughAvailable, testFeedAvailable, checking,
 * views (available) }.
 */
export function menuItems(state, env) {
  if (state.page === 'depth') return [BACK, ...depthItems(state, env)];
  if (state.page === 'video') return [BACK, ...videoItems(state, env)];
  return [
    { id: `${PAGE_PREFIX}depth`, label: 'Depth', icon: 'layers', submenu: true },
    { id: `${PAGE_PREFIX}video`, label: 'Video', icon: 'video', submenu: true },
  ];
}

/** The most buttons any page has, so the XR panel can keep its top edge still when the page changes. */
const SAMPLE_STATE = { depthMode: DEPTH_MODES[0], strength: STRENGTHS[2], fov: FOVS[0], filter: FILTERS[0], background: 'solid', view: 'normal' };
export const MENU_ROWS = 1 + Math.max(depthItems(SAMPLE_STATE).length, videoItems(SAMPLE_STATE, {}).length);

/**
 * Every label the buttons can show, on every page, so both panels can size
 * themselves to the widest one and not change width as values change. (The
 * dropdowns' choices sit two to a row in less room, so they don't set it.)
 */
export function possibleLabels(env) {
  const labels = new Set();
  const base = { ...SAMPLE_STATE, depthMesh: true };
  const variants = [
    ...DEPTH_MODES.map((depthMode) => ({ depthMode })),
    ...STRENGTHS.map((strength) => ({ strength })),
    ...FOVS.map((fov) => ({ fov })),
    ...FILTERS.map((filter) => ({ filter })),
    ...BACKGROUNDS.map((background) => ({ background })),
    ...VIEWS.map((view) => ({ view })),
    { depthMesh: false },
  ];
  for (const page of PAGES)
    for (const v of variants) for (const item of menuItems({ ...base, ...v, page }, env)) labels.add(item.label);
  return [...labels];
}
