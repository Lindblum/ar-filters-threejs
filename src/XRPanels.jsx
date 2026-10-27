import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { XRMenuPanel } from './XRMenuPanel.jsx';
import { holding, readControllers } from './grip.js';
import { pulse } from './haptics.js';

// The XR panels (menu.js panelModels: Options and View), each drawn by the XR
// template (XRMenuPanel), docked and grabbed as in grid-game-threejs.
//
// Docked on a controller (the left at first, or the other one while it's
// missing), they stand stacked upward on its grip, top to bottom in the
// models' order, left edges in line, the bottom one centred over the controller,
// tilted back toward the face. Without controllers they stand in the same
// stack ahead and to the left of where the session started, and travel with
// the player.
//
// A grip pressed touching or pointing at a panel takes it, held rigidly in
// the hand (easing from its docked size to its free size); let go near the
// other controller it docks there, anywhere else it stays in the room. While
// a grip holds a panel, that hand's thumbstick pushes it away / reels it in
// (up / down) along the controller's ray and turns it about the ray (left /
// right), and does nothing else. A double tap of a grip docks the panel it
// touches or points at on that controller, or, at no panel, lets go of the
// panels docked there, leaving them where they are; a triple tap summons
// every undocked panel to that controller, flying there.

const HANDS = ['left', 'right'];
// docked, in grip space (-Z forward out of the controller, +Y up out of its top): the stack's bottom here...
const DOCK_ANCHOR = new THREE.Vector3(0, 0.05, 0.02);
const DOCK_TILT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.5); // ...the top leaning back toward the face
const DOCK_SCALE = 0.5;
const DOCK_GAP = 0.008; // m between stacked panels
// without controllers: the stack's middle here, in the player's origin, turned toward them
const GAZE_POSE = new THREE.Matrix4().compose(
  new THREE.Vector3(-0.65, 1.05, -0.2),
  new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.9, 0)),
  new THREE.Vector3(1, 1, 1),
);
// a phone's stereo view is blurrier and smaller than a headset's: bigger panels stay readable
const PHONE_STEREO_SCALE = 1.5;
const TOUCH_REACH = 0.03; // m: a grip this near a panel's face takes it
const DOCK_REACH = 0.12; // m: a held panel let go this near the other controller docks there
const GROW_RATE = 12; // per second: a panel in the hand eases to its free size
const TAP_S = 0.3; // a grip pressed no longer than this is a tap...
const DOUBLE_TAP_S = 0.35; // ...and pressed again within this, a double tap (once more: a triple tap)
const FLY_S = 0.4; // a summoned panel flies to its dock over this long
// a held panel's thumbstick: up / down pushes it along the ray, per second at full tilt this share of its distance...
const PUSH_RATE = 1.5;
const PUSH_MIN_M = 0.25; // ...but never slower than at this distance (m)
const REEL_MIN_M = 0.05; // it reels in no nearer the hand than this (m)
const ROLL_RATE = Math.PI; // left / right turns it about the ray, at most this fast (rad/s)
const STICK_DEADZONE = 0.2;
const THUMBSTICK = [2, 3]; // xr-standard gamepad axes: x, y
// haptics: [strength, ms]
const PULSE = { grab: [0.6, 50], detach: [0.4, 30], dock: [0.9, 80], zone: [0.25, 20] };

const _m = new THREE.Matrix4();
const _n = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _local = new THREE.Matrix4();
const _raycaster = new THREE.Raycaster();

const other = (hand) => (hand === 'left' ? 'right' : 'left');

/** Panel group `group`'s face mesh, and its visible box in the group's metres at scale 1 ({ left, right, bottom, top }), or null before it has drawn. */
function faceOf(group) {
  const mesh = group?.children.find((c) => c.isMesh && c.userData.panelBox);
  if (!mesh) return null;
  const b = mesh.userData.panelBox;
  const { x, y } = mesh.position;
  return { mesh, box: { left: b.left + x, right: b.right + x, bottom: b.bottom + y, top: b.top + y } };
}

/** Sets `object`'s pose (in its parent) so its world matrix is `world`. */
function setWorld(object, world) {
  _local.copy(object.parent.matrixWorld).invert().multiply(world);
  _local.decompose(object.position, object.quaternion, object.scale);
  object.updateMatrixWorld();
}

/**
 * `models`: the panel models (menu.js panelModels), top to bottom; `onSelect`:
 * their presses. `textScale`: Accessibility → Text Size.
 */
export function XRPanels({ panels: models, onSelect, textScale, phoneStereo }) {
  const gl = useThree((s) => s.gl);
  const PANELS = models.map((m) => m.key);
  // each panel's group, by key
  const groups = useRef({}).current;
  for (const key of PANELS) groups[key] ??= { current: null };
  // each panel: where it's docked ('left', 'right' or null: free in the room), where it
  // shows now ('left', 'right', 'gaze', or null: free), and its flight to a dock
  const panels = useRef({});
  for (const key of PANELS) panels.current[key] ??= { dock: 'left', on: null, fly: null };
  const grabs = useRef({}); // hand -> { key, offset (grip -> panel), point (held by, grip space), size, grow, zone }
  const taps = useRef({}); // hand -> { pressedAt, tappedAt, count }
  const squeezeWas = useRef({});
  const lastText = useRef(textScale);
  const freeScale = textScale * (phoneStereo ? PHONE_STEREO_SCALE : 1);

  /** The panel `c` (of `hand`) touches, or else points at, not counting those docked on it: { key, point (world) } or null. */
  const panelAt = (hand, c) => {
    const shown = PANELS.filter((key) => panels.current[key].on !== hand && groups[key].current?.visible);
    for (const key of shown) {
      const face = faceOf(groups[key].current);
      if (!face) continue;
      const local = face.mesh.worldToLocal(c.position.clone());
      const r = TOUCH_REACH / face.mesh.getWorldScale(_s).x;
      const b = face.mesh.userData.panelBox;
      if (Math.abs(local.z) < r && local.x > b.left - r && local.x < b.right + r && local.y > b.bottom - r && local.y < b.top + r)
        return { key, point: c.position.clone() };
    }
    _raycaster.ray.copy(c.ray);
    _raycaster.far = 3;
    for (const key of shown) {
      const face = faceOf(groups[key].current);
      const hit = face && _raycaster.intersectObject(face.mesh, false)[0];
      if (!hit) continue;
      const local = face.mesh.worldToLocal(hit.point.clone());
      const b = face.mesh.userData.panelBox;
      if (local.x >= b.left && local.x <= b.right && local.y >= b.bottom && local.y <= b.top) return { key, point: hit.point.clone() };
    }
    return null;
  };

  /** `hand`'s grip takes panel `at.key` (off its dock, if it was docked): held rigidly, easing to its free size about the point it was taken by. */
  const takePanel = (hand, c, at) => {
    const e = panels.current[at.key];
    const group = groups[at.key].current;
    pulse(c.gamepad, ...(e.on ? PULSE.detach : PULSE.grab));
    Object.assign(e, { dock: null, on: null, fly: null }); // (caught in flight)
    for (const h of HANDS) if (grabs.current[h]?.key === at.key) delete grabs.current[h]; // (the other hand lets go)
    group.updateMatrixWorld();
    const gripInverse = c.grip.clone().invert();
    grabs.current[hand] = {
      key: at.key,
      offset: gripInverse.clone().multiply(group.matrixWorld),
      point: at.point.clone().applyMatrix4(gripInverse),
      size: 1,
      grow: freeScale / group.getWorldScale(_s).x,
      zone: null,
    };
  };

  /** The other controller, when it's within DOCK_REACH of held panel `key`: where letting go docks it; else null. */
  const dockZone = (hand, key, controllers) => {
    const c = controllers[other(hand)];
    const face = faceOf(groups[key].current);
    if (!c || !face) return null;
    const b = face.mesh.userData.panelBox;
    const local = face.mesh.worldToLocal(c.position.clone());
    local.set(THREE.MathUtils.clamp(local.x, b.left, b.right), THREE.MathUtils.clamp(local.y, b.bottom, b.top), 0);
    return face.mesh.localToWorld(local).distanceTo(c.position) < DOCK_REACH ? other(hand) : null;
  };

  const gripStart = (hand, c, now) => {
    const tap = (taps.current[hand] ??= { pressedAt: -1, tappedAt: -Infinity, count: 0 });
    tap.count = now - tap.tappedAt < DOUBLE_TAP_S ? tap.count + 1 : 1; // (this press: the count-th tap in a row)
    tap.tappedAt = -Infinity;
    tap.pressedAt = now;
    if (tap.count >= 3) {
      // a triple tap: every undocked panel flies to this controller
      const free = PANELS.filter((key) => !panels.current[key].dock && groups[key].current);
      if (!free.length) return;
      for (const key of free) {
        for (const h of HANDS) if (grabs.current[h]?.key === key) delete grabs.current[h];
        const group = groups[key].current;
        group.updateMatrixWorld();
        const fly = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: new THREE.Vector3(), t0: now };
        group.matrixWorld.decompose(fly.pos, fly.quat, fly.scale);
        Object.assign(panels.current[key], { dock: hand, fly });
      }
      pulse(c.gamepad, ...PULSE.dock);
      return;
    }
    const at = panelAt(hand, c);
    if (tap.count === 2) {
      if (at) {
        // a double tap at a panel docks it here
        for (const h of HANDS) if (grabs.current[h]?.key === at.key) delete grabs.current[h];
        panels.current[at.key].dock = hand;
        pulse(c.gamepad, ...PULSE.dock);
      } else {
        // at nothing: the panels docked here stay where they are, free
        const mine = PANELS.filter((key) => panels.current[key].on === hand);
        for (const key of mine) Object.assign(panels.current[key], { dock: null, on: null, fly: null });
        if (mine.length) pulse(c.gamepad, ...PULSE.detach);
      }
      return;
    }
    if (at) takePanel(hand, c, at);
  };

  const gripEnd = (hand, c, now, controllers) => {
    const tap = taps.current[hand];
    if (tap) tap.tappedAt = tap.count < 3 && now - tap.pressedAt <= TAP_S ? now : -Infinity; // (a short press: a tap, unless it ended a triple)
    const g = grabs.current[hand];
    if (!g) return;
    delete grabs.current[hand];
    const zone = dockZone(hand, g.key, controllers);
    if (!zone) return;
    panels.current[g.key].dock = zone;
    pulse(controllers[zone]?.gamepad, ...PULSE.dock);
  };

  /** A held panel: its thumbstick pushes / reels it along the ray and turns it about the ray; then it keeps its pose in the hand, easing to its free size. */
  const updateHeld = (hand, c, dt, controllers) => {
    const g = grabs.current[hand];
    const group = groups[g.key].current;
    const axis = (i) => {
      const v = c.gamepad.axes[THUMBSTICK[i]] ?? 0;
      return Math.abs(v) < STICK_DEADZONE ? 0 : v;
    };
    const x = axis(0);
    const y = axis(1);
    if (x || y) {
      // in the grip's space: the ray's direction, and the panel's pose and the point it's held by
      c.grip.decompose(_v, _q, _s);
      const dir = c.ray.direction.clone().applyQuaternion(_q.invert());
      if (y) {
        const dist = g.point.length();
        const u = dir.clone().multiplyScalar(Math.max(-y * PUSH_RATE * Math.max(dist, PUSH_MIN_M) * dt, REEL_MIN_M - dist));
        g.offset.premultiply(_m.makeTranslation(u.x, u.y, u.z));
        g.point.add(u);
      }
      if (x) {
        // about the ray through the point it's held by: right turns it clockwise, as you look along the ray
        const p = g.point;
        _m.makeTranslation(p.x, p.y, p.z).multiply(_n.makeRotationAxis(dir, x * ROLL_RATE * dt)).multiply(_n.makeTranslation(-p.x, -p.y, -p.z));
        g.offset.premultiply(_m);
      }
    }
    g.size += (g.grow - g.size) * (1 - Math.exp(-GROW_RATE * dt));
    const { x: px, y: py, z: pz } = g.point;
    _m.makeTranslation(px, py, pz).multiply(_n.makeScale(g.size, g.size, g.size)).multiply(_n.makeTranslation(-px, -py, -pz)).multiply(g.offset);
    setWorld(group, _m.premultiply(c.grip));
    const zone = dockZone(hand, g.key, controllers);
    if (zone && zone !== g.zone) pulse(controllers[zone]?.gamepad, ...PULSE.zone); // (a tick as it comes within reach)
    g.zone = zone;
  };

  /**
   * Panels `keys` (top to bottom) stacked upward in `parent` (a world matrix): on a controller, from
   * DOCK_ANCHOR, tilted; without (`centred`), upright about its middle.
   */
  const layoutStack = (keys, parent, centred, scale, now) => {
    const stack = keys
      .map((key) => ({ key, group: groups[key].current, face: faceOf(groups[key].current) }))
      .filter((p) => p.face)
      .reverse(); // (bottom first)
    if (!stack.length) return;
    const heights = stack.map(({ face: { box } }) => (box.top - box.bottom) * scale);
    let y = centred ? -(heights.reduce((a, h) => a + h, 0) + DOCK_GAP * (stack.length - 1)) / 2 : 0;
    const b0 = stack[0].face.box;
    const left = -((b0.right - b0.left) / 2) * scale; // (left edges in line, the bottom one centred)
    stack.forEach(({ key, group, face: { box } }, i) => {
      _v.set(left - box.left * scale, y - box.bottom * scale, i * 0.0005); // (each a hair in front of the last)
      _q.identity();
      if (!centred) {
        _v.applyQuaternion(DOCK_TILT).add(DOCK_ANCHOR);
        _q.copy(DOCK_TILT);
      }
      const world = new THREE.Matrix4().compose(_v, _q, _s.setScalar(scale)).premultiply(parent);
      const fly = panels.current[key].fly;
      if (fly) {
        // flying in: between where it set off and its place, eased
        const t = Math.min(1, (now - fly.t0) / FLY_S);
        if (t >= 1) panels.current[key].fly = null;
        else {
          const k = THREE.MathUtils.smootherstep(t, 0, 1);
          const to = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: new THREE.Vector3() };
          world.decompose(to.pos, to.quat, to.scale);
          world.compose(fly.pos.clone().lerp(to.pos, k), fly.quat.clone().slerp(to.quat, k), fly.scale.clone().lerp(to.scale, k));
        }
      }
      setWorld(group, world);
      y += heights[i] + DOCK_GAP;
    });
  };

  useFrame((state, delta, frame) => {
    const origin = PANELS.map((key) => groups[key].current?.parent).find(Boolean);
    if (!origin) return;
    origin.updateWorldMatrix(true, false);
    const now = state.clock.elapsedTime;
    const dt = Math.min(delta, 0.1);
    const referenceSpace = gl.xr.getReferenceSpace();
    const controllers = frame && referenceSpace ? readControllers(frame, referenceSpace, origin) : {};

    // Text Size changed: free and held panels grow or shrink in place (docked ones follow below)
    if (textScale !== lastText.current) {
      const k = textScale / lastText.current;
      lastText.current = textScale;
      for (const key of PANELS) {
        const group = groups[key].current;
        const held = HANDS.find((h) => grabs.current[h]?.key === key);
        if (held) grabs.current[held].offset.multiply(_m.makeScale(k, k, k));
        else if (!panels.current[key].dock && group) group.scale.multiplyScalar(k);
      }
    }

    for (const hand of HANDS) {
      const c = controllers[hand];
      const pressed = Boolean(c?.squeeze);
      if (pressed && !squeezeWas.current[hand]) gripStart(hand, c, now);
      if (!pressed && squeezeWas.current[hand]) {
        if (c) gripEnd(hand, c, now, controllers);
        else delete grabs.current[hand]; // (the controller went away: the panel stays where it is)
      }
      squeezeWas.current[hand] = pressed;
      if (grabs.current[hand] && c) updateHeld(hand, c, dt, controllers);
      holding[hand] = Boolean(grabs.current[hand]);
    }

    // docked panels: on their controller, the other one while it's missing, or ahead without controllers
    const rows = { left: [], right: [], gaze: [] };
    for (const key of PANELS) {
      const e = panels.current[key];
      if (!e.dock) {
        e.on = null;
        continue;
      }
      e.on = controllers[e.dock] ? e.dock : controllers[other(e.dock)] ? other(e.dock) : 'gaze';
      rows[e.on].push(key);
    }
    for (const hand of HANDS) if (rows[hand].length) layoutStack(rows[hand], controllers[hand].grip, false, DOCK_SCALE * textScale, now);
    if (rows.gaze.length) layoutStack(rows.gaze, _n.multiplyMatrices(origin.matrixWorld, GAZE_POSE).clone(), true, freeScale, now);
  });

  // gone (out of XR): nothing is held any more
  useEffect(
    () => () => {
      for (const hand of HANDS) holding[hand] = false;
    },
    [],
  );

  // every panel by the one XR template; sized and placed every frame above (no position
  // props, so a re-render never undoes a move)
  return (
    <>
      {models.map(({ key, ...model }) => (
        <XRMenuPanel key={key} {...model} onSelect={onSelect} groupRef={groups[key]} />
      ))}
    </>
  );
}
