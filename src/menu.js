// Options menu model shared by the windowed panel (DOM) and the XR panel
// (drawn on a canvas): one list of buttons, each "Name: Value". A button
// toggles or cycles its setting, runs an action, opens a submenu (an arrow
// on its right), or opens a dropdown list of choices beneath it (a chevron
// on its right).

import { BOX_LABELS, SCAN_MODES } from './scan.js';

export const MENU_TITLE = 'Room Mesh';

/** Options → Background, in list order (passthrough last). */
export const BACKGROUNDS = ['solid', 'skybox', 'passthrough'];
const BACKGROUND_LABELS = { solid: 'Solid', skybox: 'Skybox', passthrough: 'Passthrough (XR Only)' };

/** The Vite + React starter's page colour, used for the Solid background, as in the 4D viewer. */
export const SOLID_BACKGROUND = '#242424';

/** The backgrounds this device can show: passthrough only where there is AR. */
export const availableBackgrounds = (env) => BACKGROUNDS.filter((b) => b !== 'passthrough' || env.passthroughAvailable);

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
export const PAGES = ['main', 'room', 'scan', 'video'];
const PAGE_TITLES = { main: MENU_TITLE, room: 'Room', scan: 'Scan', video: 'Video' };
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

/** Room → Style: how the room's surfaces are drawn. */
export const STYLES = ['wireframe', 'solid', 'occlusion'];
const STYLE_LABELS = { wireframe: 'Wireframe', solid: 'Solid', occlusion: 'Occlusion' };

/** Room → Cell Size: the obstacle map's resolution, in metres. */
export const CELL_SIZES = [0.05, 0.1, 0.2];
const cellLabel = (m) => `${Math.round(m * 100)} cm`;

/** Scan → Mode: what the controller's tip records (see scan.js). */
const SCAN_MODE_LABELS = { off: 'Off', points: 'Points', walls: 'Walls', box: 'Box' };
const SCAN_MODE_ICONS = { off: 'probe', points: 'points', walls: 'planes', box: 'box' };
const capitalise = (s) => s[0].toUpperCase() + s.slice(1);

/** The dropdowns' ids. */
export const DROPDOWNS = ['style', 'cell', 'scanMode', 'scanLabel', 'background', 'view'];

/** The on / off settings, by button id. */
export const TOGGLES = ['planes', 'meshes', 'obstacles', 'scans'];

/** One-shot actions, by button id. */
export const ACTIONS = ['roomCapture', 'export', 'clear', 'scanBuild', 'scanUndo', 'scanCalibrate', 'scanClear'];

/**
 * The choices behind each dropdown on this device, in list order. App
 * applies a pick ("pick:<id>:<index>") by its index into these.
 */
export function dropdownChoices(env) {
  return {
    style: STYLES,
    cell: CELL_SIZES,
    scanMode: SCAN_MODES,
    scanLabel: BOX_LABELS,
    background: availableBackgrounds(env),
    view: env.views ?? ['normal'],
  };
}

const onOff = (on) => (on ? 'On' : 'Off');

/**
 * `env.roomCapture`: the session can open the headset's Space Setup;
 * `env.hasRoom`: there is a room to export or clear.
 */
function roomItems(state, env) {
  return [
    { id: 'planes', label: `Planes: ${onOff(state.planes)}`, icon: 'planes', title: 'Shortcut: P' },
    { id: 'meshes', label: `Meshes: ${onOff(state.meshes)}`, icon: 'mesh', title: 'Shortcut: M' },
    {
      id: 'style',
      label: `Style: ${STYLE_LABELS[state.style]}`,
      icon: 'style',
      title: 'Shortcut: Y. Occlusion hides the surfaces but lets them hide virtual things behind them',
      dropdown: dropdown(state, 'style', STYLES.map((s) => STYLE_LABELS[s]), STYLES.indexOf(state.style)),
    },
    { id: 'obstacles', label: `Obstacle Map: ${onOff(state.obstacles)}`, icon: 'obstacles', title: 'Shortcut: O' },
    {
      id: 'cell',
      label: `Cell Size: ${cellLabel(state.cell)}`,
      icon: 'ruler',
      dropdown: dropdown(state, 'cell', CELL_SIZES.map(cellLabel), CELL_SIZES.indexOf(state.cell)),
    },
    {
      id: 'roomCapture',
      label: 'Room Setup',
      icon: 'scan',
      disabled: !env.roomCapture,
      title: env.roomCapture
        ? "Opens the headset's Space Setup, to scan or redraw the room"
        : 'Needs an XR session in the Quest Browser',
    },
    { id: 'export', label: 'Export Room (.glb)', icon: 'download', disabled: !env.hasRoom, title: 'Shortcut: X' },
    { id: 'clear', label: 'Clear Room', icon: 'clear', disabled: !env.hasRoom },
  ];
}

/**
 * `env.scanPending`: points wait to become a shape; `env.canUndo`: there is
 * something to undo; `env.hasScans`: anything has been scanned.
 */
function scanItems(state, env) {
  const shaping = state.scanMode === 'walls' || state.scanMode === 'box';
  return [
    {
      id: 'scanMode',
      label: `Mode: ${SCAN_MODE_LABELS[state.scanMode]}`,
      icon: SCAN_MODE_ICONS[state.scanMode],
      title: "Touch real surfaces with the right controller's tip and press the trigger",
      dropdown: dropdown(
        state,
        'scanMode',
        SCAN_MODES.map((m) => SCAN_MODE_LABELS[m]),
        SCAN_MODES.indexOf(state.scanMode),
        SCAN_MODES.map((m) => SCAN_MODE_ICONS[m]),
      ),
    },
    {
      id: 'scanLabel',
      label: `Box Label: ${capitalise(state.scanLabel)}`,
      icon: 'tag',
      disabled: state.scanMode !== 'box',
      dropdown: dropdown(state, 'scanLabel', BOX_LABELS.map(capitalise), BOX_LABELS.indexOf(state.scanLabel)),
    },
    { id: 'scanBuild', label: 'Build Shape (A)', icon: 'check', disabled: !(shaping && env.scanPending) },
    { id: 'scanUndo', label: 'Undo (B)', icon: 'undo', disabled: !env.canUndo },
    {
      id: 'scanCalibrate',
      label: 'Calibrate Tip',
      icon: 'probe',
      title: 'Hold the tip on one spot, hold the trigger and swivel the controller: it learns where the tip is',
    },
    { id: 'scans', label: `Scans: ${onOff(state.scans)}`, icon: 'mesh' },
    { id: 'scanClear', label: 'Clear Scans', icon: 'clear', disabled: !env.hasScans },
  ];
}

function videoItems(state, env) {
  const backgrounds = availableBackgrounds(env);
  const views = env.views ?? ['normal'];
  return [
    {
      id: 'background',
      label: `Background: ${BACKGROUND_LABELS[state.background]}`,
      icon: state.background,
      title: env.passthroughAvailable ? undefined : 'Passthrough needs an AR-capable headset or a phone camera',
      dropdown: dropdown(
        state,
        'background',
        backgrounds.map((b) => BACKGROUND_LABELS[b]),
        backgrounds.indexOf(state.background),
        backgrounds,
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
 * `env`: { xrSupported, passthroughAvailable, checking, views (available),
 * roomCapture, hasRoom, scanPending, canUndo, hasScans }.
 */
export function menuItems(state, env) {
  if (state.page === 'room') return [BACK, ...roomItems(state, env)];
  if (state.page === 'scan') return [BACK, ...scanItems(state, env)];
  if (state.page === 'video') return [BACK, ...videoItems(state, env)];
  return [
    { id: `${PAGE_PREFIX}room`, label: 'Room', icon: 'room', submenu: true },
    { id: `${PAGE_PREFIX}scan`, label: 'Scan', icon: 'probe', submenu: true },
    { id: `${PAGE_PREFIX}video`, label: 'Video', icon: 'video', submenu: true },
  ];
}

/** The most buttons any page has, so the XR panel can keep its top edge still when the page changes. */
const SAMPLE_STATE = { style: STYLES[0], cell: CELL_SIZES[0], scanMode: SCAN_MODES[0], scanLabel: BOX_LABELS[0] };
export const MENU_ROWS =
  1 + Math.max(roomItems(SAMPLE_STATE, {}).length, scanItems(SAMPLE_STATE, {}).length, videoItems(SAMPLE_STATE, {}).length);

/**
 * Every label the buttons can show, on every page, so both panels can size
 * themselves to the widest one and not change width as values change. (The
 * dropdowns' choices sit two to a row in less room, so they don't set it.)
 */
export function possibleLabels(env) {
  const labels = new Set();
  const base = {
    planes: true,
    meshes: true,
    style: STYLES[0],
    obstacles: true,
    cell: CELL_SIZES[0],
    scanMode: SCAN_MODES[0],
    scanLabel: BOX_LABELS[0],
    scans: true,
    background: 'solid',
    view: 'normal',
  };
  const variants = [
    ...STYLES.map((style) => ({ style })),
    ...CELL_SIZES.map((cell) => ({ cell })),
    ...SCAN_MODES.map((scanMode) => ({ scanMode })),
    ...BOX_LABELS.map((scanLabel) => ({ scanLabel })),
    ...BACKGROUNDS.map((background) => ({ background })),
    ...VIEWS.map((view) => ({ view })),
    { planes: false, meshes: false, obstacles: false, scans: false },
  ];
  for (const page of PAGES)
    for (const v of variants) for (const item of menuItems({ ...base, ...v, page }, env)) labels.add(item.label);
  return [...labels];
}
