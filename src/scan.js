import * as THREE from 'three';
import { floorHeight, getRoom, notifyRoom, triangleCount } from './room.js';

// Touch-to-scan: the room measured with a controller. A Quest 2 can't see
// the room in depth, but it tracks its controllers to a few millimetres, so
// a controller's tip held against a real surface is a 3D point on it.
// Scanner (Scan.jsx) reads the right controller; this module turns the
// points it records into room entries, alongside the headset's own planes
// and meshes (room.js), in the same XROrigin space:
//   points: a click records a point, holding the trigger traces a stroke.
//   walls: corners of the room, in order, at any height. Two make a wall;
//   three or more close into walls, a floor and a ceiling.
//   box: three or more points on an object's top (its corners, say). The
//   box runs from the floor to the highest point, unless the points span
//   more than BOX_SPREAD in height, when it runs between them instead (a
//   wall cabinet: touch a top corner and a bottom one).
// Scanned entries have source 'scan', so the session never drops them; a
// new session starts a new room all the same, since its origin moves.

export const SCAN_MODES = ['off', 'points', 'walls', 'box'];
/** Box → Label, as Space Setup names furniture (see LABEL_COLORS). */
export const BOX_LABELS = ['table', 'couch', 'chair', 'bed', 'storage', 'screen', 'other'];

export const TRACE_STEP = 0.01; // metres between the points of a traced stroke
export const MAX_PENDING = 20000; // points in one stroke or shape
const DEFAULT_WALL_HEIGHT = 2.4; // metres, when no corner was touched up high
const CEILING_TOUCH = 1.8; // a corner this far above the floor sets the walls' height
const BOX_SPREAD = 0.1; // metres of height between a box's points that make it float
const MIN_SIZE = 0.02; // the thinnest a box can be

const TIP_KEY = 'room-mesh:tip-offset';

function loadTipOffset() {
  try {
    const v = JSON.parse(localStorage.getItem(TIP_KEY));
    return Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) ? new THREE.Vector3(...v) : null;
  } catch {
    return null;
  }
}

/**
 * The scan in progress. `pending`: the points of the shape or stroke being
 * recorded (Vector3, origin space). `last`: the last point recorded, for the
 * tape measure. `history`: each finished shape's entry ids, for Undo.
 * `tipOffset`: the tip in the right controller's grip space, from Calibrate
 * Tip (null: the target ray's origin). `calibrating`: the next trigger hold
 * calibrates. `message`: a line for the panels, or null.
 */
export const scan = {
  pending: [],
  last: null,
  history: [],
  tipOffset: loadTipOffset(),
  calibrating: false,
  message: null,
};

let nextId = 1;

/** Adds the pieces of one shape ({ kind, label, geometry, matrix? }) to the room, as one Undo step. */
function addShape(pieces) {
  const room = getRoom();
  const ids = [];
  for (const { kind, label, geometry, matrix } of pieces) {
    const id = `scan-${nextId++}`;
    if (kind !== 'points') geometry.computeBoundsTree?.();
    room.entries.set(id, {
      id,
      kind,
      source: 'scan',
      label,
      geometry,
      matrix: matrix ?? new THREE.Matrix4(),
      triangles: kind === 'points' ? 0 : triangleCount(geometry),
      changed: null,
    });
    ids.push(id);
  }
  scan.history.push(ids);
  notifyRoom();
}

const floorY = () => floorHeight([...getRoom().entries.values()]);

/** Finishes the current stroke (points mode) as a point cloud. */
export function commitStroke() {
  const points = scan.pending;
  scan.pending = [];
  if (!points.length) return;
  addShape([{ kind: 'points', label: 'scan points', geometry: new THREE.BufferGeometry().setFromPoints(points) }]);
}

/** Builds the walls or box from the pending points. Returns false, with a message, if there aren't enough. */
export function finishShape(mode, label) {
  const points = scan.pending;
  if (mode === 'walls') {
    if (points.length < 2) return say('Walls need 2 or more corners');
    addShape(wallPieces(points, floorY()));
  } else if (mode === 'box') {
    if (points.length < 3) return say('A box needs 3 or more points');
    addShape([boxPiece(points, floorY(), label)]);
  } else return false;
  scan.pending = [];
  scan.message = null;
  return true;
}

function say(message) {
  scan.message = message;
  return false;
}

/** Drops the last pending point, or else the last finished shape. */
export function undoScan() {
  if (scan.pending.length) {
    scan.pending.pop();
    scan.last = scan.pending.at(-1) ?? null;
    return;
  }
  const room = getRoom();
  while (scan.history.length) {
    const ids = scan.history.pop().filter((id) => room.entries.has(id)); // Clear Room may have taken some
    if (!ids.length) continue;
    for (const id of ids) {
      room.entries.get(id).geometry.dispose();
      room.entries.delete(id);
    }
    notifyRoom();
    return;
  }
}

export function clearScans() {
  const room = getRoom();
  for (const [id, entry] of room.entries)
    if (entry.source === 'scan') {
      entry.geometry.dispose();
      room.entries.delete(id);
    }
  scan.pending = [];
  scan.last = null;
  scan.history = [];
  notifyRoom();
}

export const canUndo = () => scan.pending.length > 0 || scan.history.some((ids) => ids.some((id) => getRoom().entries.has(id)));

// ---------------------------------------------------------------------------
// Shapes

/** A flat polygon in the x-z plane at height y, as triangles. */
function flatPolygon(points, y) {
  const contour = points.map((p) => new THREE.Vector2(p.x, p.z));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.flatMap((p) => [p.x, y, p.z]), 3));
  geometry.setIndex(THREE.ShapeUtils.triangulateShape(contour, []).flat());
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Walls straight up from the floor through each corner, in order. Their
 * height is the highest corner's if one was touched up high, else
 * DEFAULT_WALL_HEIGHT. Three or more corners close the loop and add a floor
 * and a ceiling.
 */
function wallPieces(corners, floor) {
  const highest = Math.max(...corners.map((p) => p.y));
  const top = highest > floor + CEILING_TOUCH ? highest : floor + DEFAULT_WALL_HEIGHT;
  const closed = corners.length >= 3;
  const pieces = [];
  for (let i = 0; i < corners.length - (closed ? 0 : 1); i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([a.x, floor, a.z, b.x, floor, b.z, b.x, top, b.z, a.x, top, a.z], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.computeVertexNormals();
    pieces.push({ kind: 'plane', label: 'wall', geometry });
  }
  if (closed) {
    pieces.push({ kind: 'plane', label: 'floor', geometry: flatPolygon(corners, floor) });
    pieces.push({ kind: 'plane', label: 'ceiling', geometry: flatPolygon(corners, top) });
  }
  return pieces;
}

/** The convex hull of points in x-z (Andrew's monotone chain), counter-clockwise. */
function hull(points) {
  const p = [...points].sort((a, b) => a.x - b.x || a.z - b.z);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const half = (list) => {
    const out = [];
    for (const q of list) {
      while (out.length >= 2 && cross(out.at(-2), out.at(-1), q) <= 0) out.pop();
      out.push(q);
    }
    return out.slice(0, -1);
  };
  return [...half(p), ...half(p.reverse())];
}

/**
 * The smallest rectangle around points in x-z: one of its sides lies along
 * an edge of their hull. { ux, uz (its long-ish axis), minU, maxU, minV,
 * maxV (the extents along u and v = (-uz, ux)) }, or null if the points
 * coincide.
 */
export function minAreaRect(points) {
  const h = hull(points);
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const a = h[i];
    const b = h[(i + 1) % h.length];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1e-6) continue;
    const ux = (b.x - a.x) / len;
    const uz = (b.z - a.z) / len;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of h) {
      const u = p.x * ux + p.z * uz;
      const v = -p.x * uz + p.z * ux;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) best = { area, ux, uz, minU, maxU, minV, maxV };
  }
  return best;
}

/** A box around the points, turned to fit them; see the top of this file for its height. */
function boxPiece(points, floor, label) {
  const rect = minAreaRect(points) ?? { ux: 1, uz: 0, minU: points[0].x, maxU: points[0].x, minV: points[0].z, maxV: points[0].z };
  const ys = points.map((p) => p.y);
  const high = Math.max(...ys);
  const low = high - Math.min(...ys) > BOX_SPREAD ? Math.min(...ys) : floor;
  const width = Math.max(rect.maxU - rect.minU, MIN_SIZE);
  const depth = Math.max(rect.maxV - rect.minV, MIN_SIZE);
  const height = Math.max(high - low, MIN_SIZE);
  const cu = (rect.minU + rect.maxU) / 2;
  const cv = (rect.minV + rect.maxV) / 2;
  const centre = new THREE.Vector3(cu * rect.ux - cv * rect.uz, low + height / 2, cu * rect.uz + cv * rect.ux);
  // the box's x along u: a turn about y by atan2(-uz, ux) takes x to u and z to v
  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-rect.uz, rect.ux));
  const matrix = new THREE.Matrix4().compose(centre, turn, new THREE.Vector3(1, 1, 1));
  return { kind: 'mesh', label, geometry: new THREE.BoxGeometry(width, height, depth), matrix };
}

// ---------------------------------------------------------------------------
// Tip calibration (pivot calibration): with the tip held on one fixed point
// and the controller swivelled around it, every grip pose (R, t) satisfies
// R·tip + t = pivot. Least squares over the poses gives both the tip (in grip
// space) and the pivot.

const MIN_SAMPLES = 60;
const MIN_SWIVEL = THREE.MathUtils.degToRad(30); // the widest turn between samples it needs
const MAX_ERROR = 0.01; // metres RMS: worse means the tip slipped
const MAX_TIP = 0.3; // metres from the grip: further is a bad fit

export function startCalibration() {
  scan.calibrating = true;
  scan.message = null;
}

/** Solves for the tip from grip poses (Matrix4[]), sets and saves it. Returns the message it shows. */
export function calibrateTip(samples) {
  scan.calibrating = false;
  if (samples.length < MIN_SAMPLES) return (scan.message = 'Calibrate: hold the trigger longer');
  const q0 = new THREE.Quaternion().setFromRotationMatrix(samples[0]);
  const q = new THREE.Quaternion();
  let swivel = 0;
  for (const m of samples) swivel = Math.max(swivel, q.setFromRotationMatrix(m).angleTo(q0));
  if (swivel < MIN_SWIVEL) return (scan.message = 'Calibrate: swivel the controller more');

  // normal equations of [R | -I]·[tip; pivot] = -t, 6×6, by Gaussian elimination
  const M = Array.from({ length: 6 }, () => new Float64Array(7));
  for (const m of samples) {
    const e = m.elements; // column-major
    for (let r = 0; r < 3; r++) {
      const row = [e[r], e[4 + r], e[8 + r], r === 0 ? -1 : 0, r === 1 ? -1 : 0, r === 2 ? -1 : 0];
      const b = -e[12 + r];
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 6; j++) M[i][j] += row[i] * row[j];
        M[i][6] += row[i] * b;
      }
    }
  }
  for (let c = 0; c < 6; c++) {
    let p = c;
    for (let r = c + 1; r < 6; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-9) return (scan.message = 'Calibrate: no fit, try again');
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 6; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 7; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = M.map((row, i) => row[6] / row[i]);
  const tip = new THREE.Vector3(x[0], x[1], x[2]);
  const pivot = new THREE.Vector3(x[3], x[4], x[5]);
  let sum = 0;
  const p = new THREE.Vector3();
  for (const m of samples) sum += p.copy(tip).applyMatrix4(m).distanceToSquared(pivot);
  const error = Math.sqrt(sum / samples.length);
  if (error > MAX_ERROR || tip.length() > MAX_TIP)
    return (scan.message = `Calibrate: tip slipped (${Math.round(error * 1000)} mm), try again`);
  scan.tipOffset = tip;
  try {
    localStorage.setItem(TIP_KEY, JSON.stringify(tip.toArray()));
  } catch {
    // not saved: it lasts until the page reloads
  }
  return (scan.message = `Tip calibrated, ${Math.round(error * 1000)} mm error`);
}
