import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { iconSvg } from './Icon.jsx';
import { SECTION_PREFIX, SET_PREFIX, sliderValue, splitLabel } from './menu.js';
import { useGazeTarget } from './Gaze.jsx';

// The options panel in XR. It draws the same menu model as the windowed
// panel (title, status lines, "Name: Value" buttons, and the shared
// open / collapsed state) onto a canvas, since WebXR can't show page
// elements. Collapsed, it is just the frame around the gear button. Controller rays, hand
// pinches and gaze pick a control from where they hit the texture. A panel taller
// than MAX_HEIGHT scrolls under its title: push the right thumbstick up or
// down while pointing at it.

const W = 1000; // canvas px of the reference width...
const WIDTH_M = 0.44; // ...which is this many metres: sets the text size in XR
const PAD = 40;
const TITLE_Y = 72;
const LINE_H = 40; // each status line
const BUTTON_H = 62;
const GAP = 22;
const ICON = 44;
const ICON_GAP = 28; // between icon and text
const TOGGLE = 72; // collapse button size
const TOGGLE_TOP = TITLE_Y - TOGGLE / 2;
// the collapsed panel: the frame around the gear button, which stays where it is in the open panel
const COLLAPSED_W = PAD + TOGGLE + PAD;
const COLLAPSED_H = TOGGLE_TOP + TOGGLE + TOGGLE_TOP;
const PX_M = WIDTH_M / W; // metres per canvas px
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
export const MENU_TOGGLE = 'menu:toggle';
const MAX_HEIGHT = 1300; // canvas px, about 57 cm: taller panels scroll
const SCROLL_SPEED = 1400; // canvas px per second at full stick
const STICK_DEADZONE = 0.2;
const THUMBSTICK_Y = 3; // xr-standard gamepad axis
const SCROLLBAR = 8;

const iconImages = new Map();
function iconImage(name, onLoad) {
  if (!iconImages.has(name)) {
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(iconSvg(name))}`;
    iconImages.set(name, img);
  }
  const img = iconImages.get(name);
  if (!img.complete) img.addEventListener('load', onLoad, { once: true });
  return img;
}

const BUTTON_FONT = `500 34px ${FONT}`;
const TITLE_FONT = `650 46px ${FONT}`;
const INSET = 18; // icon from the button's left edge, text from its right
const VALUE_GAP = 40; // at least this between a setting's name and its value
const TRAILING = 36; // a section's or a dropdown's chevron, at the right edge
const SECTION_INDENT = 54; // a section's settings, beneath its button
// a dropdown's choices: two to a row beneath its button, indented
const OPTION_FONT = `400 30px ${FONT}`;
const OPTION_H = 52;
const OPTION_GAP = 12;
const OPTION_INDENT = 54;
const CHECK = 30;
// a slider: its track between the name and a value wide enough for "0.25×"
const TRACK_H = 8;
const KNOB = 30;
const SLIDER_VALUE_W = 100;
const OPTION_ICON = 32;
const OPTION_ICON_GAP = 14;

let measureCtx;
function textWidth(text, font) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

/** The open panel's width: the widest possible button, or the title row if wider. */
function labelWidth(label) {
  const { name, value } = splitLabel(label);
  return value ? textWidth(`${name}:`, BUTTON_FONT) + VALUE_GAP + textWidth(value, BUTTON_FONT) : textWidth(name, BUTTON_FONT);
}

function panelWidth(title, labels) {
  const button = SECTION_INDENT + INSET + ICON + ICON_GAP + Math.max(0, ...labels.map(labelWidth)) + ICON_GAP + TRAILING + INSET;
  const titleRow = TOGGLE + 24 + textWidth(title, TITLE_FONT);
  return Math.ceil(2 * PAD + Math.max(button, titleRow));
}

/**
 * Canvas size and the hit rectangles for this state: { id, x, y, w, h } plus
 * `item` for a button or `option` for a choice in an open dropdown.
 */
function layout(open, items, lines, panelW) {
  const toggle = { id: MENU_TOGGLE, x: PAD, y: TOGGLE_TOP, w: TOGGLE, h: TOGGLE };
  if (!open) return { width: COLLAPSED_W, height: COLLAPSED_H, rects: [toggle] };
  const rects = [toggle];
  const w = panelW - 2 * PAD;
  // the sliders' tracks start together, after the widest slider name
  const sliderName = Math.max(0, ...items.filter((i) => i.slider).map((i) => textWidth(`${splitLabel(i.label).name}:`, BUTTON_FONT)));
  let y = TITLE_Y + 34 + lines * LINE_H + 16;
  for (const item of items) {
    const indent = item.indent ? SECTION_INDENT : 0;
    const r = { id: item.id, item, x: PAD + indent, y, w: w - indent, h: BUTTON_H };
    if (item.slider) {
      const x0 = r.x + INSET + ICON + ICON_GAP + sliderName + ICON_GAP + KNOB / 2;
      r.track = { x0, x1: r.x + r.w - INSET - SLIDER_VALUE_W - ICON_GAP - KNOB / 2 };
    }
    rects.push(r);
    y += BUTTON_H + GAP;
    if (!item.dropdown?.open) continue;
    const optionW = (w - indent - OPTION_INDENT - OPTION_GAP) / 2;
    item.dropdown.options.forEach((option, i) => {
      const row = Math.floor(i / 2);
      rects.push({
        id: option.id,
        option,
        x: PAD + indent + OPTION_INDENT + (i % 2) * (optionW + OPTION_GAP),
        y: y + row * (OPTION_H + OPTION_GAP),
        w: optionW,
        h: OPTION_H,
      });
    });
    y += Math.ceil(item.dropdown.options.length / 2) * (OPTION_H + OPTION_GAP) + GAP - OPTION_GAP;
  }
  // `top`: where the scrolling part starts, below the title and status
  return { width: panelW, height: y - GAP + PAD, rects, top: rects[1]?.y ?? 0 };
}

/** What a button's right edge shows: a section's or a dropdown's chevron. */
function trailingIcon(item) {
  const open = item.section?.open ?? item.dropdown?.open;
  if (open !== undefined) return open ? 'dropdownOpen' : 'dropdown';
  return null;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function fit(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

/** Text vertically centred on its ink at `cy`. */
function centredText(ctx, text, x, cy) {
  ctx.textBaseline = 'alphabetic';
  const m = ctx.measureText(text);
  ctx.fillText(text, x, cy + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2);
}

/** A slider's key at canvas x: "set:<id>:<value>", the value under x along its track. */
function sliderKey(r, px) {
  const t = (px - r.track.x0) / (r.track.x1 - r.track.x0);
  return `${SET_PREFIX}${r.id}:${sliderValue(r.item.slider, t)}`;
}

function drawButtonFrame(ctx, r, { hot, disabled }) {
  roundRect(ctx, r.x, r.y, r.w, r.h, 18);
  ctx.fillStyle = disabled ? 'rgba(255, 255, 255, 0.04)' : hot ? 'rgba(255, 255, 255, 0.24)' : 'rgba(255, 255, 255, 0.10)';
  ctx.fill();
  ctx.strokeStyle = hot ? 'rgba(255, 255, 255, 0.85)' : 'rgba(255, 255, 255, 0.16)';
  ctx.lineWidth = hot ? 4 : 2;
  ctx.stroke();
}

/**
 * A slider row: icon, name, the track with the knob at the value, and the
 * value at the right edge. `hot`: the key under the pointer, whose value
 * shows as a ghost knob, so gaze and rays show where a press will set it.
 */
function drawSlider(ctx, r, hot, redraw) {
  const { item, track } = r;
  drawButtonFrame(ctx, r, { hot: Boolean(hot) });
  const img = iconImage(item.icon, redraw);
  if (img.complete && img.naturalWidth) ctx.drawImage(img, r.x + INSET, r.y + (r.h - ICON) / 2, ICON, ICON);
  const { name, value } = splitLabel(item.label);
  const cy = r.y + r.h / 2;
  ctx.fillStyle = '#ffffff';
  ctx.font = BUTTON_FONT;
  centredText(ctx, `${name}:`, r.x + INSET + ICON + ICON_GAP, cy);
  ctx.textAlign = 'right';
  centredText(ctx, value, r.x + r.w - INSET, cy);
  ctx.textAlign = 'left';
  const { min, max } = item.slider;
  const at = (v) => track.x0 + ((v - min) / (max - min)) * (track.x1 - track.x0);
  const x = at(item.slider.value);
  roundRect(ctx, track.x0, cy - TRACK_H / 2, track.x1 - track.x0, TRACK_H, TRACK_H / 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
  ctx.fill();
  roundRect(ctx, track.x0, cy - TRACK_H / 2, x - track.x0, TRACK_H, TRACK_H / 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.fill();
  if (hot) {
    ctx.beginPath();
    ctx.arc(at(Number(hot.slice(hot.lastIndexOf(':') + 1))), cy, KNOB / 2, 0, 2 * Math.PI);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(x, cy, KNOB / 2, 0, 2 * Math.PI);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

export function XRMenuPanel({ title, status, items, labels, rows, open, onSelect, groupRef, ...groupProps }) {
  const mesh = useRef(null);
  const [pointerKey, setPointerKey] = useState(null);
  const [gazeKey, setGazeKey] = useState(null);
  const [iconsLoaded, setIconsLoaded] = useState(0);
  const statusLines = status ?? [];
  const lines = statusLines.length;
  const statusKey = statusLines.join('|'); // redraw when any line changes
  const panelW = useMemo(() => panelWidth(title, labels ?? items.map((i) => i.label)), [title, labels, items]);
  const { width, height: contentHeight, rects, top } = useMemo(() => layout(open, items, lines, panelW), [open, items, lines, panelW]);
  // taller than MAX_HEIGHT: the buttons scroll between the title and the bottom edge
  const height = open ? Math.min(contentHeight, MAX_HEIGHT) : contentHeight;
  const maxScroll = contentHeight - height;
  const clipTop = top - GAP / 2;
  const clipBottom = height - PAD / 2;
  const [scroll, setScroll] = useState(0);
  const scrolled = Math.min(scroll, maxScroll);
  const pointing = useRef(false);

  // an opened dropdown scrolls its choices into view
  const openDropdown = items.find((item) => item.dropdown?.open)?.id;
  useEffect(() => {
    if (!openDropdown) return;
    const first = rects.findIndex((r) => r.id === openDropdown);
    const last = rects.findLastIndex((r) => r.option);
    if (first < 0 || last < first) return;
    setScroll((s) => {
      const bottom = rects[last].y + rects[last].h - s;
      return bottom <= clipBottom ? s : Math.min(s + bottom - clipBottom, rects[first].y - top);
    });
    // only when a dropdown opens, so the stick can scroll freely afterwards
  }, [openDropdown]);

  // the right thumbstick scrolls while a pointer is on the panel
  useFrame((_, dt, frame) => {
    if (!pointing.current || maxScroll <= 0 || !frame) return;
    for (const source of frame.session.inputSources) {
      if (source.handedness !== 'right') continue;
      const y = source.gamepad?.axes[THUMBSTICK_Y] ?? 0;
      if (Math.abs(y) < STICK_DEADZONE) continue;
      setScroll((s) => THREE.MathUtils.clamp(Math.min(s, maxScroll) + y * SCROLL_SPEED * Math.min(dt, 0.1), 0, maxScroll));
    }
  });
  // the height with every section open: a shorter menu and the collapsed gear keep to its top edge
  const openHeight = useMemo(
    () => layout(true, Array.from({ length: Math.max(rows ?? 0, items.length) }, () => ({})), lines, panelW).height,
    [rows, items.length, lines, panelW],
  );

  const canvas = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }, [width, height]);
  const texture = useMemo(() => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }, [canvas]);
  useEffect(() => () => texture.dispose(), [texture]);

  const hovered = gazeKey ?? pointerKey;
  useEffect(() => {
    const ctx = canvas.getContext('2d');
    const redraw = () => setIconsLoaded((n) => n + 1);
    ctx.clearRect(0, 0, width, height);

    roundRect(ctx, 4, 4, width - 8, height - 8, 40);
    ctx.fillStyle = 'rgba(12, 16, 28, 0.9)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 4;
    ctx.stroke();

    // the gear button, top left, in the title row: collapses and expands the panel
    const toggle = rects[0];
    drawButtonFrame(ctx, toggle, { hot: hovered === MENU_TOGGLE });
    const gear = iconImage('gear', redraw);
    const gearSize = toggle.w * 0.5;
    if (gear.complete && gear.naturalWidth)
      ctx.drawImage(gear, toggle.x + (toggle.w - gearSize) / 2, toggle.y + (toggle.h - gearSize) / 2, gearSize, gearSize);
    if (!open) {
      texture.needsUpdate = true;
      return;
    }

    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = TITLE_FONT;
    centredText(ctx, fit(ctx, title, width - 2 * PAD - TOGGLE - 24), PAD + TOGGLE + 24, TITLE_Y);
    ctx.fillStyle = 'rgba(232, 236, 246, 0.6)';
    ctx.font = `400 26px ${FONT}`;
    statusLines.forEach((line, i) => centredText(ctx, fit(ctx, line, width - 2 * PAD), PAD, TITLE_Y + 34 + LINE_H / 2 + i * LINE_H));


    // the buttons, scrolled and clipped below the title
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, clipTop, width, clipBottom - clipTop);
    ctx.clip();
    ctx.translate(0, -scrolled);
    for (const r of rects) {
      if (r.id === MENU_TOGGLE) continue;
      if (r.option) {
        // a choice in an open dropdown: smaller, the current one lit and ticked, one this device can't use dimmed
        const { option } = r;
        ctx.globalAlpha = option.disabled ? 0.4 : 1;
        roundRect(ctx, r.x, r.y, r.w, r.h, 14);
        const hot = option.id === hovered;
        ctx.fillStyle = hot ? 'rgba(255, 255, 255, 0.24)' : option.selected ? 'rgba(255, 255, 255, 0.16)' : 'rgba(255, 255, 255, 0.05)';
        ctx.fill();
        ctx.strokeStyle = hot || option.selected ? 'rgba(255, 255, 255, 0.6)' : 'rgba(255, 255, 255, 0.12)';
        ctx.lineWidth = hot ? 4 : 2;
        ctx.stroke();
        let tx = r.x + INSET;
        if (option.icon) {
          const icon = iconImage(option.icon, redraw);
          if (icon.complete && icon.naturalWidth) ctx.drawImage(icon, tx, r.y + (r.h - OPTION_ICON) / 2, OPTION_ICON, OPTION_ICON);
          tx += OPTION_ICON + OPTION_ICON_GAP;
        }
        ctx.fillStyle = '#ffffff';
        ctx.font = OPTION_FONT;
        const room = r.x + r.w - INSET - tx - (option.selected ? CHECK + 10 : 0);
        centredText(ctx, fit(ctx, option.label, room), tx, r.y + r.h / 2);
        if (option.selected) {
          const check = iconImage('check', redraw);
          if (check.complete && check.naturalWidth) ctx.drawImage(check, r.x + r.w - INSET - CHECK, r.y + (r.h - CHECK) / 2, CHECK, CHECK);
        }
        ctx.globalAlpha = 1;
        continue;
      }
      const { item } = r;
      if (item.slider) {
        drawSlider(ctx, r, hovered?.startsWith(`${SET_PREFIX}${item.id}:`) ? hovered : null, redraw);
        continue;
      }
      drawButtonFrame(ctx, r, { hot: item.id === hovered && !item.disabled, disabled: item.disabled });
      ctx.globalAlpha = item.disabled ? 0.4 : 1;
      const img = iconImage(item.icon, redraw);
      if (img.complete && img.naturalWidth) ctx.drawImage(img, r.x + INSET, r.y + (r.h - ICON) / 2, ICON, ICON);
      ctx.fillStyle = '#ffffff';
      ctx.font = BUTTON_FONT;
      // the name on the left, the value against the right edge
      const tx = r.x + INSET + ICON + ICON_GAP;
      let right = r.x + r.w - INSET;
      const trailing = trailingIcon(item);
      if (trailing) {
        const icon = iconImage(trailing, redraw);
        if (icon.complete && icon.naturalWidth) ctx.drawImage(icon, right - TRAILING, r.y + (r.h - TRAILING) / 2, TRAILING, TRAILING);
        right -= TRAILING + ICON_GAP;
      }
      const { name, value } = splitLabel(item.label);
      const nameText = value ? `${name}:` : name;
      centredText(ctx, fit(ctx, nameText, right - tx), tx, r.y + r.h / 2);
      if (value) {
        const room = right - tx - ctx.measureText(nameText).width - VALUE_GAP;
        ctx.textAlign = 'right';
        centredText(ctx, fit(ctx, value, room), right, r.y + r.h / 2);
        ctx.textAlign = 'left';
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    if (maxScroll > 0) {
      // scrollbar, in the right padding
      const trackH = clipBottom - clipTop;
      const thumbH = Math.max(60, (trackH * height) / contentHeight);
      const thumbY = clipTop + ((trackH - thumbH) * scrolled) / maxScroll;
      const x = width - PAD / 2 - SCROLLBAR / 2;
      roundRect(ctx, x, clipTop, SCROLLBAR, trackH, SCROLLBAR / 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.fill();
      roundRect(ctx, x, thumbY, SCROLLBAR, thumbH, SCROLLBAR / 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.fill();
    }
    texture.needsUpdate = true;
  }, [canvas, texture, width, height, contentHeight, rects, clipTop, clipBottom, scrolled, maxScroll, open, title, statusKey, hovered, iconsLoaded]);

  const pick = (hit) => {
    if (!hit?.uv) return null;
    const px = hit.uv.x * width;
    let py = (1 - hit.uv.y) * height;
    const inside = (q) => px >= q.x && px <= q.x + q.w && py >= q.y && py <= q.y + q.h;
    if (open && inside(rects[0])) return MENU_TOGGLE; // the title row doesn't scroll
    if (open && (py < clipTop || py > clipBottom)) return null;
    if (open) py += scrolled;
    const r = rects.find(inside);
    if (r?.track) return sliderKey(r, px);
    return r && !r.item?.disabled && !r.option?.disabled ? r.id : null;
  };
  // the gear, sections and dropdowns open and close: a stare fires them once
  const toggles = (key) => key === MENU_TOGGLE || key.startsWith(SECTION_PREFIX) || Boolean(rects.find((r) => r.id === key)?.item?.dropdown);
  useGazeTarget(mesh, onSelect, setGazeKey, pick, toggles);

  return (
    <group ref={groupRef} {...groupProps}>
      <mesh
        ref={mesh}
        position={[((width - panelW) / 2) * PX_M, ((openHeight - height) / 2) * PX_M, 0]}
        onPointerOver={() => (pointing.current = true)}
        onPointerMove={(e) => setPointerKey(pick(e))}
        onPointerOut={() => {
          pointing.current = false;
          setPointerKey(null);
        }}
        onClick={(e) => {
          const key = pick(e);
          if (key == null) return;
          e.stopPropagation();
          onSelect(key);
        }}
      >
        <planeGeometry args={[width * PX_M, height * PX_M]} />
        <meshBasicMaterial map={texture} transparent depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}
