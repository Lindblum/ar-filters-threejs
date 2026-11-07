// What each input does here, for Options → Controls (controlsGuide.js draws it) and the
// XR Control Guides (ControllerGuide.jsx labels the controllers with xrTexts).

/**
 * What each part of `hand`'s controller does: { componentId: text }. Grips
 * take, dock and summon the panels (see XRPanels); a grip `holding` one gives
 * its stick to it. Otherwise the left stick moves and the right turns (see
 * Scene's Player), and also scrolls the Options panel it points at.
 */
export function xrTexts(hand, holding = false) {
  const t = { 'xr-standard-trigger': 'Press panels' };
  if (holding) {
    t['xr-standard-squeeze'] = 'Let go to drop';
    t['xr-standard-thumbstick'] = '↕ Push / pull\n↔ Turn it';
  } else {
    t['xr-standard-squeeze'] = 'Grab a panel\n×2: Dock / undock panels\n×3: Summon panels';
    t['xr-standard-thumbstick'] = hand === 'left' ? 'Move' : '↔ Turn\n↕ Scroll the panel';
  }
  return t;
}

/** Each input's controls (see controlsGuide.js): no gamepad controls yet. */
export const CONTROLS = {
  mk: {
    mouse: {
      left: 'Drag: orbit',
      middle: 'Drag: zoom',
      wheel: 'Zoom',
      right: 'Drag: pan',
    },
    keys: [
      { keys: ['F'], action: 'Next filter' },
      { keys: ['Shift', 'F'], action: 'Previous filter' },
      { keys: ['Enter', '/', 'Esc'], action: 'Options' },
    ],
  },
  pad: null,
  xr: { left: xrTexts('left'), right: xrTexts('right') },
};
