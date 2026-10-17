import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { isShown } from './Grab.jsx';
import { floorHeight, getRoom, getRoomVersion } from './room.js';
import { MAX_PENDING, TRACE_STEP, calibrateTip, canUndo, commitStroke, finishShape, scan, undoScan } from './scan.js';

// The right Touch controller as a measuring probe: see scan.js for what each
// mode builds. The trigger records (a press that starts on the panel is the
// panel's), A builds the shape, B undoes. A haptic tick confirms each point.

// xr-standard gamepad buttons on a Touch controller
const TRIGGER = 0;
const BUTTON_A = 4;
const BUTTON_B = 5;
const MAX_CALIBRATION_SAMPLES = 900; // about 10 s at 90 Hz
const REPORT_EVERY = 0.2; // seconds between status reports
export const SCAN_COLORS = { points: '#7dffb0', walls: '#f2a65a', box: '#9be08a', calibrate: '#ff6bd5' };

const _grip = new THREE.Matrix4();
const _ray = new THREE.Matrix4();
const _tip = new THREE.Vector3();

function pulse(gamepad, intensity, ms) {
  try {
    gamepad.hapticActuators?.[0]?.pulse?.(intensity, ms);
  } catch {
    // no haptics: the preview still shows the point
  }
}

/**
 * Records points with the right controller's tip and draws the scan in
 * progress: the tip, the pending points, and for walls and boxes a line
 * through them back to the tip. A child of the XROrigin, so poses relative
 * to the reference space apply as they are. `panels`: refs to the menu
 * panels, whose presses it leaves alone. `onStatus(status | null)` reports
 * what the panels show, a few times a second.
 */
export function Scanner({ mode, label, panels, onStatus }) {
  const gl = useThree((s) => s.gl);
  const root = useRef(null);
  const tip = useRef(null);
  const tipMaterial = useRef(null);
  const preview = useRef(null);
  const press = useRef({ trigger: false, a: false, b: false, action: null }); // action: what the held trigger does
  const samples = useRef([]);
  const written = useRef(0); // pending points already in the preview buffer
  const floor = useRef({ version: -1, y: 0 });
  const lastReport = useRef({ t: -Infinity, key: null });
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  // the pending points, then the tip and the first point again (closing the loop)
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const position = new THREE.BufferAttribute(new Float32Array((MAX_PENDING + 2) * 3), 3);
    position.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', position);
    g.setDrawRange(0, 0);
    return g;
  }, []);
  useEffect(() => () => geometry.dispose(), [geometry]);

  // a new mode starts a new shape
  useEffect(() => {
    scan.pending = [];
    scan.message = null;
  }, [mode]);

  const pointsAtPanel = (frame, source, referenceSpace) => {
    const pose = frame.getPose(source.targetRaySpace, referenceSpace);
    const origin = root.current?.parent;
    if (!pose || !origin) return false;
    _ray.fromArray(pose.transform.matrix).premultiply(origin.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(_ray);
    raycaster.ray.direction.set(0, 0, -1).transformDirection(_ray);
    return panels.some((panel) => panel.current && isShown(panel.current) && raycaster.intersectObject(panel.current, true).length);
  };

  const report = (t, status) => {
    const key = status && JSON.stringify(status);
    if (key === lastReport.current.key || (status && t - lastReport.current.t < REPORT_EVERY)) return;
    lastReport.current = { t, key };
    onStatus?.(status);
  };

  useFrame(({ clock }, _, frame) => {
    const referenceSpace = gl.xr.getReferenceSpace();
    const source =
      frame && [...frame.session.inputSources].find((s) => s.handedness === 'right' && s.gripSpace && s.gamepad && !s.hand);
    const gripPose = source && referenceSpace && frame.getPose(source.gripSpace, referenceSpace);
    const active = (mode !== 'off' || scan.calibrating) && Boolean(gripPose);
    root.current.visible = active;
    if (!active) {
      press.current = { trigger: false, a: false, b: false, action: null };
      report(clock.elapsedTime, null);
      return;
    }

    // the tip: calibrated, else where the controller's ray starts
    _grip.fromArray(gripPose.transform.matrix);
    if (scan.tipOffset) _tip.copy(scan.tipOffset).applyMatrix4(_grip);
    else {
      const rayPose = frame.getPose(source.targetRaySpace, referenceSpace);
      const p = rayPose?.transform.position;
      if (p) _tip.set(p.x, p.y, p.z);
      else _tip.setFromMatrixPosition(_grip);
    }

    // the buttons, on their edges
    const buttons = source.gamepad.buttons;
    const trigger = Boolean(buttons[TRIGGER]?.pressed);
    const a = Boolean(buttons[BUTTON_A]?.pressed);
    const b = Boolean(buttons[BUTTON_B]?.pressed);
    const state = press.current;
    if (trigger && !state.trigger) {
      state.action = pointsAtPanel(frame, source, referenceSpace) ? null : scan.calibrating ? 'calibrate' : mode;
      if (state.action === 'calibrate') samples.current = [];
      else if (state.action === 'points') scan.pending = [];
      if (state.action && state.action !== 'calibrate') pulse(source.gamepad, 0.4, 20);
    }
    if (trigger && state.action === 'calibrate') {
      if (samples.current.length < MAX_CALIBRATION_SAMPLES) samples.current.push(_grip.clone());
    } else if (trigger && state.action && scan.pending.length < MAX_PENDING) {
      // walls and boxes take one point a press; a stroke takes one every TRACE_STEP
      const last = scan.pending.at(-1);
      if (!state.trigger || (state.action === 'points' && last.distanceTo(_tip) >= TRACE_STEP)) {
        scan.pending.push(_tip.clone());
        scan.last = scan.pending.at(-1);
      }
    }
    if (!trigger && state.trigger) {
      if (state.action === 'calibrate') {
        calibrateTip(samples.current);
        samples.current = [];
        pulse(source.gamepad, 0.6, 80);
      } else if (state.action === 'points') commitStroke();
      state.action = null;
    }
    if (a && !state.a && (mode === 'walls' || mode === 'box') && finishShape(mode, label)) pulse(source.gamepad, 0.7, 60);
    if (b && !state.b && !state.action) undoScan();
    state.trigger = trigger;
    state.a = a;
    state.b = b;

    // the preview
    const colour = SCAN_COLORS[scan.calibrating ? 'calibrate' : mode];
    tip.current.position.copy(_tip);
    tipMaterial.current.color.set(colour);
    preview.current.children.forEach((o) => o.material.color.set(colour));
    const pending = scan.pending;
    const position = geometry.attributes.position;
    if (pending.length < written.current) written.current = 0; // undone or restarted: rewrite it all
    const from = written.current;
    for (let i = from; i < pending.length; i++) position.setXYZ(i, pending[i].x, pending[i].y, pending[i].z);
    written.current = pending.length;
    let count = pending.length;
    if (mode !== 'points' && pending.length) {
      position.setXYZ(count++, _tip.x, _tip.y, _tip.z); // the next point, wherever the tip goes
      if (pending.length >= 2) position.setXYZ(count++, pending[0].x, pending[0].y, pending[0].z);
    }
    position.clearUpdateRanges();
    if (count > from) {
      position.addUpdateRange(from * 3, (count - from) * 3);
      position.needsUpdate = true;
    }
    geometry.setDrawRange(0, count);

    // the status: what's pending, and the tape measure
    const version = getRoomVersion();
    if (floor.current.version !== version) floor.current = { version, y: floorHeight([...getRoom().entries.values()]) };
    const cm = (m) => Math.round(m * 100) / 100;
    report(clock.elapsedTime, {
      mode,
      calibrating: scan.calibrating,
      samples: samples.current.length,
      pending: pending.length,
      height: cm(_tip.y - floor.current.y),
      fromLast: scan.last ? cm(scan.last.distanceTo(_tip)) : null,
      message: scan.message,
      canUndo: canUndo(),
    });
  });

  const overlay = { transparent: true, depthTest: false, depthWrite: false, toneMapped: false };
  return (
    <group ref={root} visible={false}>
      <mesh ref={tip} renderOrder={950} raycast={() => null}>
        <sphereGeometry args={[0.006, 12, 8]} />
        <meshBasicMaterial ref={tipMaterial} {...overlay} />
      </mesh>
      <group ref={preview}>
        <line geometry={geometry} renderOrder={940} frustumCulled={false} raycast={() => null}>
          <lineBasicMaterial {...overlay} opacity={0.85} />
        </line>
        <points geometry={geometry} renderOrder={941} frustumCulled={false} raycast={() => null}>
          <pointsMaterial size={0.008} {...overlay} />
        </points>
      </group>
    </group>
  );
}
