// The menu's settings, kept in a cookie so they survive a reload. Scoped to
// this app's path, so other pages on the same host (GitHub Pages serves
// several apps from one domain) neither see nor clobber it. Each value is
// checked as it comes back, so a stale or edited cookie can only fall back
// to the default, never put the menu in a state it can't show.

import { FILTERS } from './filters.js';
import { BACKGROUNDS, CONVERGENCE, DEPTH_MODES, PERIPHERIES, SECTIONS, SMOOTHING, STRENGTH } from './menu.js';

const COOKIE = 'depth-xr-settings';
const MAX_AGE = 60 * 60 * 24 * 365; // seconds: a year

const oneOf = (list) => (v) => list.includes(v);
const inRange = ({ min, max }) => (v) => typeof v === 'number' && v >= min && v <= max;

/** Each saved setting and what counts as a valid value for it. */
const VALID = {
  depthMode: oneOf(DEPTH_MODES),
  depthMesh: (v) => typeof v === 'boolean',
  smoothing: inRange(SMOOTHING),
  convergence: inRange(CONVERGENCE),
  strength: inRange(STRENGTH),
  periphery: oneOf(PERIPHERIES),
  filter: oneOf(FILTERS),
  background: oneOf(BACKGROUNDS),
  menuOpen: (v) => typeof v === 'boolean',
  sections: (v) => Array.isArray(v) && v.every((s) => SECTIONS.includes(s)),
};

/** The directory this page is served from, e.g. "/room-mesh-threejs/". */
const cookiePath = () => location.pathname.replace(/[^/]*$/, '');

/** The saved settings that are still valid: { [name]: value }, possibly empty. */
export function loadSettings() {
  try {
    const entry = document.cookie.split('; ').find((c) => c.startsWith(`${COOKIE}=`));
    if (!entry) return {};
    const saved = JSON.parse(decodeURIComponent(entry.slice(COOKIE.length + 1)));
    return Object.fromEntries(Object.entries(saved).filter(([name, value]) => VALID[name]?.(value)));
  } catch {
    return {};
  }
}

/** Saves the settings named in VALID from `state`. */
export function saveSettings(state) {
  const settings = Object.fromEntries(Object.keys(VALID).map((name) => [name, state[name]]));
  const value = encodeURIComponent(JSON.stringify(settings));
  document.cookie = `${COOKIE}=${value}; max-age=${MAX_AGE}; path=${cookiePath()}; SameSite=Lax`;
}
