import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { useXRStore } from '@react-three/xr';
import * as THREE from 'three';
import { holding } from './grip.js';

// Accessibility → Controller Guide (XR), as in grid-game-threejs: a label
// beside each of a controller's buttons, sticks, triggers and grips saying
// what it does. Each label points, with a thin leader line, at the middle of
// that part on the controller's own model (the motion-controllers profile's
// nodes for it); the labels stand in a column out to the side of the
// controller as you see it (top to bottom as the buttons sit). Parts with
// nothing to do get no label.

/** The components labelled, in the column's order (top to bottom). */
const COMPONENTS = ['menu', 'y-button', 'b-button', 'x-button', 'a-button', 'xr-standard-thumbstick', 'xr-standard-trigger', 'xr-standard-squeeze'];
const FONT_PX = 40;
const LINE_PX = 50; // a text line's height on the canvas
const PAD_PX = 12;
const CANVAS_W = 512;
const TEXT_M = 0.009; // a text line's height in the world (m), at Text Size 100%
const OUT_M = 0.07; // the outer column's distance from the controller, to its side (m)
const INNER_M = 0.045; // the inner column's (m): closer, leaving room between the hands
const ROW_GAP_M = 0.004; // between a column's labels (m)
const FRONT_M = 0.07; // the trigger's label: this far in front of it (m), where the controller points
/** Where each component's label goes: 'inner' (the side toward the other hand), 'outer', or 'front' (ahead of it). */
const PLACE = {
  'a-button': 'inner',
  'b-button': 'inner',
  'x-button': 'inner',
  'y-button': 'inner',
  'xr-standard-squeeze': 'inner',
  'xr-standard-trigger': 'front',
  'xr-standard-thumbstick': 'outer',
  menu: 'outer',
};

/**
 * What each part of `hand`'s controller does: { componentId: text }. Grips
 * take, dock and summon the panels (see XRPanels); a grip holding one gives
 * its stick to it. Otherwise the left stick moves and the right turns (see
 * Scene's Player), and also scrolls the Options panel it points at.
 */
function guideTexts(hand) {
  const t = { 'xr-standard-trigger': 'Press panels' };
  if (holding[hand]) {
    t['xr-standard-squeeze'] = 'Let go to drop';
    t['xr-standard-thumbstick'] = '↕ Push / pull\n↔ Turn it';
  } else {
    t['xr-standard-squeeze'] = 'Grab a panel\n×2: Dock / undock panels\n×3: Summon panels';
    t['xr-standard-thumbstick'] = hand === 'left' ? 'Move' : '↔ Turn\n↕ Scroll the panel';
  }
  return t;
}

const _p = new THREE.Vector3();
const _at = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _box = new THREE.Box3();

const partNodes = new WeakMap(); // controller model -> component id -> its nodes

/**
 * Where component `id` sits on controller model `model`: the centre of its
 * parts' shapes (its root node and its visual responses' nodes), not a node's
 * origin (a part's pivot is often elsewhere); into `out`. Null when the model
 * has none of them.
 */
function componentCentre(model, id, component, out) {
  let byId = partNodes.get(model);
  if (!byId) partNodes.set(model, (byId = new Map()));
  let nodes = byId.get(id);
  if (!nodes?.length) {
    // (looked for again until found: the layout comes before the model's shape has loaded)
    const names = [
      component.rootNodeName,
      ...Object.values(component.visualResponses ?? {}).flatMap((v) => [v.valueNodeName, v.minNodeName, v.maxNodeName]),
    ];
    nodes = [...new Set(names.filter(Boolean).map((n) => model.getObjectByName(n)).filter(Boolean))];
    byId.set(id, nodes);
  }
  _box.makeEmpty();
  for (const node of nodes) _box.expandByObject(node);
  if (!_box.isEmpty()) return _box.getCenter(out);
  return nodes.length ? nodes[0].getWorldPosition(out) : null; // (no shape: its origin)
}

class Label {
  constructor(parent) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_W;
    this.canvas.height = LINE_PX + PAD_PX * 2;
    this.texture = this.makeTexture();
    this.sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.texture, depthTest: false, depthWrite: false, transparent: true, toneMapped: false }),
    );
    this.sprite.renderOrder = 951; // over the scene and the panel (900), under the reticle (1000)
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.line = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color: 0xe8f2ff, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false }),
    );
    this.line.renderOrder = 950;
    this.line.frustumCulled = false;
    for (const o of [this.sprite, this.line]) {
      o.raycast = () => {};
      o.visible = false;
      parent.add(o);
    }
    this.text = null;
  }

  makeTexture() {
    const t = new THREE.CanvasTexture(this.canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /**
   * Shows `text` (lines split by \n), redrawing only when it changed, `scale`
   * times its usual size; anchored at its `side` edge ('left': the label's
   * left edge is at its position; 'right'; 'center': its middle).
   */
  setText(text, side, scale) {
    if (text === this.text && side === this.side && scale === this.scale) return;
    this.text = text;
    this.side = side;
    this.scale = scale;
    const lines = text.split('\n');
    const h = lines.length * LINE_PX + PAD_PX * 2;
    if (this.canvas.height !== h) {
      this.canvas.height = h;
      this.texture.dispose();
      this.texture = this.makeTexture();
      this.sprite.material.map = this.texture;
    }
    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, CANVAS_W, h);
    ctx.font = `600 ${FONT_PX}px system-ui, sans-serif`;
    const w = Math.min(CANVAS_W, Math.max(...lines.map((l) => ctx.measureText(l).width)) + PAD_PX * 2);
    const x0 = side === 'left' ? 0 : side === 'center' ? (CANVAS_W - w) / 2 : CANVAS_W - w; // (the box hugs the edge nearest the controller)
    ctx.fillStyle = 'rgba(12, 16, 24, 0.78)';
    ctx.beginPath();
    ctx.roundRect(x0, 0, w, h, 14);
    ctx.fill();
    ctx.fillStyle = '#eef3fa';
    ctx.textBaseline = 'middle';
    lines.forEach((l, i) => ctx.fillText(l, x0 + PAD_PX, PAD_PX + LINE_PX * (i + 0.5)));
    this.texture.needsUpdate = true;
    const k = (TEXT_M * scale) / LINE_PX; // m per canvas px
    this.sprite.scale.set(CANVAS_W * k, h * k, 1);
    this.sprite.center.set(side === 'left' ? 0 : side === 'center' ? 0.5 : 1, 0.5);
  }

  hide() {
    this.sprite.visible = this.line.visible = false;
  }

  dispose() {
    this.texture.dispose();
    this.sprite.material.dispose();
    this.line.geometry.dispose();
    this.line.material.dispose();
  }
}

/**
 * The guide's labels while `on`. `textScale`: Accessibility → Text Size.
 *
 * Where each label goes (PLACE): A / B / X / Y and the grip in a column on
 * the controller's inner side, the stick and the menu button in one on its
 * outer side, the trigger out in front. In a column each label sits level
 * with its part where it can (its line runs straight across); labels that
 * would overlap are moved apart as a group, centred on their parts.
 */
export function ControllerGuide({ on, textScale }) {
  const store = useXRStore();
  const group = useMemo(() => new THREE.Group(), []);
  const labels = useMemo(() => ({ left: new Map(), right: new Map() }), []); // hand -> component id -> Label
  useEffect(
    () => () => {
      for (const byId of Object.values(labels)) for (const l of byId.values()) l.dispose();
    },
    [labels],
  );
  const labelOf = (hand, id) => {
    let l = labels[hand].get(id);
    if (!l) labels[hand].set(id, (l = new Label(group)));
    return l;
  };

  useFrame(({ camera }) => {
    const controllers = on ? store.getState().inputSourceStates.filter((s) => s.type === 'controller') : [];
    camera.updateMatrixWorld();
    _right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    _up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    for (const hand of ['left', 'right']) {
      const state = controllers.find((s) => s.inputSource.handedness === hand);
      const model = state?.object;
      const components = state?.layout?.components;
      if (!model?.parent || !components) {
        for (const l of labels[hand].values()) l.hide();
        continue;
      }
      const texts = guideTexts(hand);
      const outward = hand === 'left' ? -1 : 1; // (the outer side, as you see it)
      model.updateWorldMatrix(true, true);
      model.getWorldPosition(_at);
      const shown = [];
      for (const id of COMPONENTS) {
        const p = texts[id] && components[id] && componentCentre(model, id, components[id], new THREE.Vector3());
        if (!p) {
          labels[hand].get(id)?.hide();
          continue;
        }
        shown.push({ id, p, place: PLACE[id] ?? 'outer', l: labelOf(hand, id) });
      }
      for (const place of ['inner', 'outer']) {
        const side = place === 'outer' ? outward : -outward;
        const col = shown.filter((x) => x.place === place);
        for (const x of col) {
          x.l.setText(texts[x.id], side > 0 ? 'left' : 'right', textScale); // (the box's edge nearest the controller)
          x.h = x.l.sprite.scale.y;
          x.y = _p.copy(x.p).sub(_at).dot(_up); // (its part's height, as you see it)
        }
        col.sort((a, b) => b.y - a.y);
        // groups of labels that would touch, each centred on the mean height of its parts
        const groups = [];
        for (const x of col) {
          groups.push({ items: [x], h: x.h, mid: x.y });
          for (;;) {
            const g = groups.at(-1);
            const prev = groups.at(-2);
            if (!prev || prev.mid - prev.h / 2 - ROW_GAP_M >= g.mid + g.h / 2) break;
            const items = [...prev.items, ...g.items];
            const h = items.reduce((t, it) => t + it.h, 0) + ROW_GAP_M * (items.length - 1);
            groups.splice(-2, 2, { items, h, mid: items.reduce((t, it) => t + it.y, 0) / items.length });
          }
        }
        const out = (place === 'inner' ? INNER_M : OUT_M) * textScale;
        for (const g of groups) {
          let y = g.mid + g.h / 2;
          for (const x of g.items) {
            y -= x.h / 2;
            x.l.sprite.position.copy(_at).addScaledVector(_right, side * out).addScaledVector(_up, y);
            y -= x.h / 2 + ROW_GAP_M;
          }
        }
      }
      // the trigger's label: out in front of it, where the controller points (grip space -Z)
      _fwd.set(0, 0, -1).transformDirection(model.matrixWorld);
      for (const x of shown.filter((it) => it.place === 'front')) {
        x.l.setText(texts[x.id], 'center', textScale);
        x.l.sprite.position.copy(x.p).addScaledVector(_fwd, FRONT_M);
      }
      for (const { l, p } of shown) {
        const pos = l.line.geometry.getAttribute('position');
        pos.setXYZ(0, p.x, p.y, p.z);
        pos.setXYZ(1, l.sprite.position.x, l.sprite.position.y, l.sprite.position.z);
        pos.needsUpdate = true;
        l.sprite.visible = l.line.visible = true;
      }
    }
  });

  return <primitive object={group} />;
}
