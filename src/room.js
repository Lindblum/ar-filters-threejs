import * as THREE from 'three';

// The room as the headset reports it, and the obstacle map built from it.
//
// A Quest has no WebXR access to its camera images (and a Quest 2 has no
// depth sensor), so the browser can't build a mesh from the cameras itself.
// What it does expose is the room model from the headset's Space Setup:
//   plane-detection: flat polygons for the floor, ceiling, walls, doors,
//   windows and furniture tops (Quest 2 and 3; on a Quest 2 you draw them
//   in Space Setup).
//   mesh-detection: triangle meshes, the furniture volumes and, on a
//   Quest 3 / 3S, the scanned "global mesh" of the whole room.
// Each frame RoomSensor copies them into this snapshot, in the coordinates
// of the XROrigin (y up, the floor at 0), so the room stays drawn, and
// exportable, after the session ends.

/** Colours by semantic label, as Space Setup names them. */
export const LABEL_COLORS = {
  floor: '#3fa7ff',
  ceiling: '#8a8fa8',
  wall: '#f2a65a',
  'wall art': '#e08ad2',
  door: '#b07a4a',
  'door frame': '#b07a4a',
  window: '#7fe0ff',
  'window frame': '#7fe0ff',
  table: '#9be08a',
  desk: '#9be08a',
  couch: '#c08aff',
  bed: '#c08aff',
  chair: '#ffd34d',
  screen: '#ff6b6b',
  lamp: '#fff2a8',
  plant: '#5fd068',
  storage: '#d0a060',
  shelf: '#d0a060',
  'global mesh': '#e8ecf6',
  other: '#e8ecf6',
};
export const labelColor = (label) => LABEL_COLORS[label?.toLowerCase()] ?? LABEL_COLORS.other;

/**
 * The snapshot: id -> { id, kind: 'plane' | 'mesh', label, geometry
 * (BufferGeometry in the entity's own space), matrix (its pose in origin
 * space), triangles, changed (the entity's lastChangedTime) }. `version`
 * bumps on every change, for useSyncExternalStore.
 */
const room = { entries: new Map(), bounds: null, version: 0, features: null, boundsAvailable: false };
const listeners = new Set();

export const subscribeRoom = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
export const getRoomVersion = () => room.version;
export const getRoom = () => room;

export function notifyRoom() {
  room.version++;
  for (const fn of listeners) fn();
}

let nextId = 1;
const ids = new WeakMap(); // XRPlane / XRMesh -> id

export function entityId(entity) {
  let id = ids.get(entity);
  if (!id) ids.set(entity, (id = `${nextId++}`));
  return id;
}

export function clearRoom() {
  for (const entry of room.entries.values()) entry.geometry.dispose();
  room.entries.clear();
  room.bounds = null;
  room.features = null;
  room.boundsAvailable = false;
  notifyRoom();
}

/** A detected plane's polygon (in its own x-z plane, y along its normal) as triangles. */
export function planeGeometry(polygon) {
  const contour = polygon.map(({ x, z }) => new THREE.Vector2(x, z));
  const geometry = new THREE.BufferGeometry();
  if (contour.length < 3) return geometry;
  const faces = THREE.ShapeUtils.triangulateShape(contour, []);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(polygon.flatMap(({ x, z }) => [x, 0, z]), 3));
  geometry.setIndex(faces.flat());
  geometry.computeVertexNormals();
  return geometry;
}

/** A detected mesh's triangles, copied (the session may reuse its buffers). */
export function meshGeometry(mesh) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mesh.vertices), 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.indices), 1));
  geometry.computeVertexNormals();
  return geometry;
}

export const triangleCount = (geometry) => (geometry.index ? geometry.index.count : (geometry.attributes.position?.count ?? 0)) / 3;

/** Counts for the panels: planes, meshes, triangles and the labels seen. */
export function roomSummary() {
  let planes = 0;
  let meshes = 0;
  let triangles = 0;
  const labels = new Map();
  for (const e of room.entries.values()) {
    if (e.kind === 'plane') planes++;
    else meshes++;
    triangles += e.triangles;
    labels.set(e.label, (labels.get(e.label) ?? 0) + 1);
  }
  return { planes, meshes, triangles, labels };
}

// ---------------------------------------------------------------------------
// Obstacle map: a top-down occupancy grid on the floor. A cell is an
// obstacle if any surface passes through it between ankle and head height,
// so walls, furniture and table tops count, and the floor and ceiling don't.
// Cells the floor polygon covers, with nothing above them, are free;
// everything else is unknown. Each cell also gets its distance to the
// nearest obstacle, for the proximity readout.

export const OBSTACLE_LOW = 0.1; // metres above the floor
export const OBSTACLE_HIGH = 2.0;
const MAX_CELLS = 512; // per side
export const UNKNOWN = 0;
export const FREE = 1;
export const OBSTACLE = 2;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _p = new THREE.Vector3();

function forEachTriangle(entry, fn) {
  const pos = entry.geometry.attributes.position;
  if (!pos) return;
  const index = entry.geometry.index;
  const count = index ? index.count : pos.count;
  for (let i = 0; i + 2 < count; i += 3) {
    const ia = index ? index.getX(i) : i;
    const ib = index ? index.getX(i + 1) : i + 1;
    const ic = index ? index.getX(i + 2) : i + 2;
    _a.fromBufferAttribute(pos, ia).applyMatrix4(entry.matrix);
    _b.fromBufferAttribute(pos, ib).applyMatrix4(entry.matrix);
    _c.fromBufferAttribute(pos, ic).applyMatrix4(entry.matrix);
    fn(_a, _b, _c);
  }
}

/**
 * Samples a triangle at about `step` spacing, calling fn(point) for each
 * sample. Works the same for flat and vertical triangles (a wall projects to
 * a line on the floor, which still gets marked).
 */
function sampleTriangle(a, b, c, step, fn) {
  const longest = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
  const n = Math.max(1, Math.ceil(longest / step));
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n - i; j++) {
      const u = i / n;
      const v = j / n;
      _p.copy(a)
        .multiplyScalar(1 - u - v)
        .addScaledVector(b, u)
        .addScaledVector(c, v);
      fn(_p);
    }
  }
}

/** The floor's height: the lowest floor plane, else 0 (a local-floor space puts it there). */
function floorHeight(entries) {
  let y = Infinity;
  for (const e of entries) if (e.kind === 'plane' && e.label === 'floor') y = Math.min(y, e.matrix.elements[13]);
  return Number.isFinite(y) ? y : 0;
}

/**
 * Builds the grid from the snapshot. Returns null without any surfaces.
 * { cell (m), cols, rows, minX, minZ, floorY, cells (Uint8Array of
 * UNKNOWN / FREE / OBSTACLE), distance (Float32Array, metres to the nearest
 * obstacle), obstacles (count) }.
 */
export function buildObstacleGrid(cell = 0.1) {
  const entries = [...room.entries.values()];
  if (!entries.length) return null;
  const floorY = floorHeight(entries);
  const box = new THREE.Box3();
  for (const e of entries) {
    if (!e.geometry.boundingBox) e.geometry.computeBoundingBox();
    box.union(e.geometry.boundingBox.clone().applyMatrix4(e.matrix));
  }
  if (box.isEmpty()) return null;
  // grow the cells rather than the grid if the room is huge
  const span = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) + 4 * cell;
  cell = Math.max(cell, span / MAX_CELLS);
  const minX = box.min.x - 2 * cell;
  const minZ = box.min.z - 2 * cell;
  const cols = Math.ceil((box.max.x - minX) / cell) + 2;
  const rows = Math.ceil((box.max.z - minZ) / cell) + 2;
  const cells = new Uint8Array(cols * rows);
  const low = floorY + OBSTACLE_LOW;
  const high = floorY + OBSTACLE_HIGH;
  const step = cell * 0.5;
  const mark = (value) => (p) => {
    const cx = Math.floor((p.x - minX) / cell);
    const cz = Math.floor((p.z - minZ) / cell);
    if (cx < 0 || cz < 0 || cx >= cols || cz >= rows) return;
    const i = cz * cols + cx;
    if (value === OBSTACLE) {
      if (p.y >= low && p.y <= high) cells[i] = OBSTACLE;
    } else if (cells[i] === UNKNOWN) cells[i] = value;
  };
  // the floor first, so obstacles overwrite it
  const markFree = mark(FREE);
  for (const e of entries) {
    if (e.label !== 'floor') continue;
    forEachTriangle(e, (a, b, c) => sampleTriangle(a, b, c, step, markFree));
  }
  const markObstacle = mark(OBSTACLE);
  for (const e of entries) {
    if (e.label === 'floor' || e.label === 'ceiling') continue;
    forEachTriangle(e, (a, b, c) => sampleTriangle(a, b, c, step, markObstacle));
  }
  let obstacles = 0;
  for (const v of cells) if (v === OBSTACLE) obstacles++;
  return { cell, cols, rows, minX, minZ, floorY, cells, distance: distanceField(cells, cols, rows, cell), obstacles };
}

/** Metres from each cell to the nearest obstacle cell (8-neighbour chamfer, two passes). */
function distanceField(cells, cols, rows, cell) {
  const d = new Float32Array(cols * rows).fill(Infinity);
  for (let i = 0; i < d.length; i++) if (cells[i] === OBSTACLE) d[i] = 0;
  const diag = Math.SQRT2;
  const relax = (i, j, cost) => {
    if (d[j] + cost < d[i]) d[i] = d[j] + cost;
  };
  for (let z = 0; z < rows; z++)
    for (let x = 0; x < cols; x++) {
      const i = z * cols + x;
      if (x > 0) relax(i, i - 1, 1);
      if (z > 0) relax(i, i - cols, 1);
      if (x > 0 && z > 0) relax(i, i - cols - 1, diag);
      if (x < cols - 1 && z > 0) relax(i, i - cols + 1, diag);
    }
  for (let z = rows - 1; z >= 0; z--)
    for (let x = cols - 1; x >= 0; x--) {
      const i = z * cols + x;
      if (x < cols - 1) relax(i, i + 1, 1);
      if (z < rows - 1) relax(i, i + cols, 1);
      if (x < cols - 1 && z < rows - 1) relax(i, i + cols + 1, diag);
      if (x > 0 && z < rows - 1) relax(i, i + cols - 1, diag);
    }
  for (let i = 0; i < d.length; i++) d[i] *= cell;
  return d;
}

/** Metres from (x, z) in origin space to the nearest obstacle, or null off the map / with none. */
export function distanceAt(grid, x, z) {
  if (!grid?.obstacles) return null;
  const cx = Math.floor((x - grid.minX) / grid.cell);
  const cz = Math.floor((z - grid.minZ) / grid.cell);
  if (cx < 0 || cz < 0 || cx >= grid.cols || cz >= grid.rows) return null;
  return grid.distance[cz * grid.cols + cx];
}

// ---------------------------------------------------------------------------

/** Saves the snapshot as a .glb, each surface a node named by its label, in origin space. */
export async function exportRoomGLB() {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const scene = new THREE.Scene();
  scene.name = 'Room';
  for (const e of room.entries.values()) {
    const mesh = new THREE.Mesh(
      e.geometry.clone(),
      new THREE.MeshStandardMaterial({ color: labelColor(e.label), side: THREE.DoubleSide }),
    );
    mesh.name = `${e.kind} ${e.id}: ${e.label}`;
    mesh.matrix.copy(e.matrix);
    mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
    scene.add(mesh);
  }
  const glb = await new GLTFExporter().parseAsync(scene, { binary: true });
  scene.traverse((o) => {
    o.geometry?.dispose();
    o.material?.dispose();
  });
  const url = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `room-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.glb`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
