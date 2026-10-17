import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useXR } from '@react-three/xr';
import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import {
  FREE,
  OBSTACLE,
  buildObstacleGrid,
  clearRoom,
  distanceAt,
  entityId,
  getRoom,
  getRoomVersion,
  labelColor,
  meshGeometry,
  notifyRoom,
  planeGeometry,
  subscribeRoom,
  triangleCount,
} from './room.js';

// Rays from the controllers (and the mouse) hit the room every frame; a
// bounding-volume tree keeps that cheap on a Quest's dense room mesh.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const SAMPLE_EVERY = 10; // frames between reading the room's poses
const POSE_EPSILON = 1e-3; // metres / matrix units: smaller moves are tracking noise

export const useRoomVersion = () => useSyncExternalStore(subscribeRoom, getRoomVersion);

const _pose = new THREE.Matrix4();

function changed(a, b) {
  for (let i = 0; i < 16; i++) if (Math.abs(a.elements[i] - b.elements[i]) > POSE_EPSILON) return true;
  return false;
}

/**
 * Copies the session's detected planes and meshes into the room snapshot
 * (see room.js), in XROrigin space. A new session starts a new snapshot,
 * since its origin is wherever the headset started. Also notes which
 * features the session granted, and the guardian boundary if there is one.
 */
export function RoomSensor() {
  const gl = useThree((s) => s.gl);
  const session = useXR((s) => s.session);
  const frameCount = useRef(0);
  const bounded = useRef(null); // the bounded-floor space, if the session has one

  useEffect(() => {
    if (!session) return;
    clearRoom();
    const room = getRoom();
    room.features = session.enabledFeatures ? [...session.enabledFeatures] : null;
    notifyRoom();
    let live = true;
    session.requestReferenceSpace('bounded-floor').then(
      (space) => {
        if (!live) return;
        bounded.current = space;
        room.boundsAvailable = (space.boundsGeometry?.length ?? 0) >= 3;
        notifyRoom();
      },
      () => {}, // no guardian boundary (it is off in passthrough on many headsets)
    );
    return () => {
      live = false;
      bounded.current = null;
    };
  }, [session]);

  useFrame((_, __, frame) => {
    if (!frame || frameCount.current++ % SAMPLE_EVERY) return;
    const referenceSpace = gl.xr.getReferenceSpace();
    if (!referenceSpace) return;
    const room = getRoom();
    let dirty = false;

    const sample = (entity, kind, space) => {
      const pose = frame.getPose(space, referenceSpace);
      if (!pose) return;
      const id = entityId(entity);
      _pose.fromArray(pose.transform.matrix);
      let entry = room.entries.get(id);
      if (entry && entry.changed === entity.lastChangedTime) {
        if (changed(entry.matrix, _pose)) {
          entry.matrix.copy(_pose);
          dirty = true;
        }
        return;
      }
      entry?.geometry.dispose();
      const geometry = kind === 'plane' ? planeGeometry(entity.polygon) : meshGeometry(entity);
      geometry.computeBoundsTree();
      entry = {
        id,
        kind,
        label: (entity.semanticLabel || (kind === 'mesh' ? 'global mesh' : 'other')).toLowerCase(),
        geometry,
        matrix: _pose.clone(),
        triangles: triangleCount(geometry),
        changed: entity.lastChangedTime,
      };
      room.entries.set(id, entry);
      dirty = true;
    };
    const present = new Set();
    for (const plane of frame.detectedPlanes ?? []) {
      present.add(entityId(plane));
      sample(plane, 'plane', plane.planeSpace);
    }
    for (const mesh of frame.detectedMeshes ?? []) {
      present.add(entityId(mesh));
      sample(mesh, 'mesh', mesh.meshSpace);
    }
    // gone from the session: drop it (one that is only untracked this frame stays); scans aren't the session's
    for (const [id, entry] of room.entries)
      if (!present.has(id) && entry.source !== 'scan') {
        entry.geometry.dispose();
        room.entries.delete(id);
        dirty = true;
      }

    // the guardian boundary, as a polygon on the floor
    const space = bounded.current;
    const points = space?.boundsGeometry;
    if (points?.length >= 3) {
      const pose = frame.getPose(space, referenceSpace);
      if (pose) {
        _pose.fromArray(pose.transform.matrix);
        const next = Array.from(points, (p) => new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(_pose));
        const prev = room.bounds;
        if (!prev || prev.length !== next.length || prev.some((p, i) => p.distanceTo(next[i]) > POSE_EPSILON)) {
          room.bounds = next;
          dirty = true;
        }
      }
    }
    if (dirty) notifyRoom();
  });
  return null;
}

/** Each surface's look, by style. Shared per colour, so a room of 200 boxes isn't 200 materials. */
function useMaterials(style) {
  const cache = useMemo(() => new Map(), [style]);
  useEffect(
    () => () => {
      for (const m of cache.values()) for (const material of Object.values(m)) material.dispose();
    },
    [cache],
  );
  return (color) => {
    if (!cache.has(color)) {
      cache.set(
        color,
        style === 'solid'
          ? { fill: new THREE.MeshStandardMaterial({ color, roughness: 0.85, transparent: true, opacity: 0.9, side: THREE.DoubleSide }) }
          : style === 'occlusion'
            ? // invisible, but hides whatever virtual is behind it: the real room in front of virtual content
              { fill: new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }) }
            : {
                fill: new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }),
                lines: new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.55, depthWrite: false }),
                edges: new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }),
              },
      );
    }
    return cache.get(color);
  };
}

/** Scanned points, one material per colour. Drawn as is in every style. */
function usePointsMaterials() {
  const cache = useMemo(() => new Map(), []);
  useEffect(
    () => () => {
      for (const material of cache.values()) material.dispose();
    },
    [cache],
  );
  return (color) => {
    if (!cache.has(color)) cache.set(color, new THREE.PointsMaterial({ color, size: 0.008, toneMapped: false }));
    return cache.get(color);
  };
}

/** A plane's outline, or a scanned box's edges (the sharp edges of its triangles). */
function PlaneEdges({ geometry, material }) {
  const edges = useMemo(() => new THREE.EdgesGeometry(geometry), [geometry]);
  useEffect(() => () => edges.dispose(), [edges]);
  return <lineSegments geometry={edges} material={material} raycast={() => null} />;
}

/**
 * The snapshot, drawn. Put it inside the XROrigin so it stays on the real
 * room as the player moves. Pointer events on it drive the probe.
 */
export function RoomModel({ showPlanes, showMeshes, showScans, style, probe: probeRef }) {
  useRoomVersion();
  const material = useMaterials(style);
  const pointsMaterial = usePointsMaterials();
  const entries = [...getRoom().entries.values()].filter((e) =>
    e.source === 'scan' ? showScans : e.kind === 'plane' ? showPlanes : showMeshes,
  );
  // the nearest surface under any pointer: { point, normal (world), distance, label }
  const probe = (e) => {
    e.stopPropagation();
    const p = (probeRef.current ??= { point: new THREE.Vector3(), normal: new THREE.Vector3(0, 0, 1) });
    p.point.copy(e.point);
    if (e.face?.normal) p.normal.copy(e.face.normal).transformDirection(e.object.matrixWorld);
    p.distance = e.distance;
    p.label = e.object.userData.label;
    p.pointer = e.pointerId;
  };
  const leave = (e) => {
    if (probeRef.current?.pointer === e.pointerId) probeRef.current = null;
  };
  return (
    <group>
      {entries.map((e) => {
        if (e.kind === 'points')
          return (
            <points
              key={e.id}
              geometry={e.geometry}
              material={pointsMaterial(labelColor(e.label))}
              matrix={e.matrix.clone()}
              matrixAutoUpdate={false}
              raycast={() => null}
            />
          );
        const m = material(labelColor(e.label));
        const outlined = e.kind === 'plane' || e.source === 'scan';
        return (
          <group key={e.id} matrix={e.matrix.clone()} matrixAutoUpdate={false}>
            <mesh
              geometry={e.geometry}
              material={m.fill}
              userData={{ label: e.label }}
              renderOrder={style === 'occlusion' ? -10 : 0}
              onPointerMove={probe}
              onPointerOut={leave}
            />
            {m.lines && !outlined && <mesh geometry={e.geometry} material={m.lines} raycast={() => null} />}
            {m.edges && outlined && <PlaneEdges geometry={e.geometry} material={m.edges} />}
          </group>
        );
      })}
    </group>
  );
}

const _z = new THREE.Vector3(0, 0, 1);

/** Where a pointer last met the room (`probe`, a ref): a dot and a ring lying on the surface. Lives in world space. */
export function ProbeMarker({ probe }) {
  const group = useRef(null);
  const ring = useRef(null);
  useFrame(() => {
    const g = group.current;
    const p = probe.current;
    g.visible = Boolean(p);
    if (!p) return;
    g.position.copy(p.point);
    g.quaternion.setFromUnitVectors(_z, p.normal);
    ring.current.color.set(labelColor(p.label));
  });
  const overlay = { depthTest: false, depthWrite: false, transparent: true, toneMapped: false };
  return (
    <group ref={group} visible={false}>
      <mesh renderOrder={900} raycast={() => null}>
        <sphereGeometry args={[0.012, 12, 8]} />
        <meshBasicMaterial color="#ffffff" {...overlay} />
      </mesh>
      <mesh renderOrder={900} raycast={() => null}>
        <ringGeometry args={[0.035, 0.045, 32]} />
        <meshBasicMaterial ref={ring} side={THREE.DoubleSide} {...overlay} />
      </mesh>
    </group>
  );
}

/** The guardian boundary, if the session reported one. */
export function BoundsOutline() {
  useRoomVersion();
  const bounds = getRoom().bounds;
  const geometry = useMemo(() => (bounds ? new THREE.BufferGeometry().setFromPoints([...bounds, bounds[0]]) : null), [bounds]);
  useEffect(() => () => geometry?.dispose(), [geometry]);
  if (!geometry) return null;
  return (
    <line geometry={geometry} raycast={() => null}>
      <lineBasicMaterial color="#4dd2ff" transparent opacity={0.9} />
    </line>
  );
}

// the obstacle map's colours, RGBA
const MARGIN = 0.3; // metres around an obstacle drawn as the caution zone
const COLORS = {
  free: [60, 200, 255, 40],
  margin: [255, 180, 60, 110],
  obstacle: [255, 70, 70, 200],
};

/** The occupancy grid as a texture: unknown clear, free blue, the margin amber, obstacles red. */
function gridTexture(grid) {
  const data = new Uint8Array(grid.cols * grid.rows * 4);
  for (let z = 0; z < grid.rows; z++)
    for (let x = 0; x < grid.cols; x++) {
      const i = z * grid.cols + x;
      const cell = grid.cells[i];
      const colour =
        cell === OBSTACLE ? COLORS.obstacle : grid.distance[i] < MARGIN && cell !== OBSTACLE ? COLORS.margin : cell === FREE ? COLORS.free : null;
      if (!colour) continue;
      // the texture's first row is at the plane's far (-z) edge once laid flat
      data.set(colour, ((grid.rows - 1 - z) * grid.cols + x) * 4);
    }
  const texture = new THREE.DataTexture(data, grid.cols, grid.rows, THREE.RGBAFormat);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

const _head = new THREE.Vector3();
const REPORT_EVERY = 0.25; // seconds between proximity reports

/**
 * The obstacle map, laid on the floor, and a ring under the viewer that
 * turns amber, then red, as they near an obstacle. Rebuilt when the room
 * changes. `onGrid(grid)` reports the map; `onProximity(metres | null)`
 * reports the viewer's distance to the nearest obstacle, a few times a
 * second, in an XR session.
 */
export function ObstacleMap({ cell, origin, onGrid, onProximity }) {
  const version = useRoomVersion();
  const inSession = useXR((s) => s.session != null);
  const grid = useMemo(() => buildObstacleGrid(cell), [version, cell]);
  const texture = useMemo(() => grid && gridTexture(grid), [grid]);
  useEffect(() => () => texture?.dispose(), [texture]);
  useEffect(() => onGrid?.(grid), [grid, onGrid]);
  const ring = useRef(null);
  const ringMaterial = useRef(null);
  const lastReport = useRef({ t: 0, value: undefined });

  useFrame(({ camera, clock }) => {
    if (!ring.current) return;
    if (!inSession || !grid || !origin.current) {
      ring.current.visible = false;
      return;
    }
    origin.current.worldToLocal(camera.getWorldPosition(_head));
    const d = distanceAt(grid, _head.x, _head.z);
    ring.current.visible = d != null;
    ring.current.position.set(_head.x, grid.floorY + 0.02, _head.z);
    if (d != null) ringMaterial.current.color.set(d < MARGIN ? '#ff4646' : d < 2 * MARGIN ? '#ffb43c' : '#3cc8ff');
    const t = clock.elapsedTime;
    const value = d == null ? null : Math.round(d * 20) / 20;
    if (t - lastReport.current.t > REPORT_EVERY && value !== lastReport.current.value) {
      lastReport.current = { t, value };
      onProximity?.(value);
    }
  });

  useEffect(() => {
    if (!inSession) onProximity?.(null);
  }, [inSession, onProximity]);

  return (
    <>
      {grid && texture && (
        <mesh
          position={[grid.minX + (grid.cols * grid.cell) / 2, grid.floorY + 0.01, grid.minZ + (grid.rows * grid.cell) / 2]}
          rotation-x={-Math.PI / 2}
          renderOrder={1}
          raycast={() => null}
        >
          <planeGeometry args={[grid.cols * grid.cell, grid.rows * grid.cell]} />
          <meshBasicMaterial map={texture} transparent depthWrite={false} polygonOffset polygonOffsetFactor={-2} toneMapped={false} />
        </mesh>
      )}
      <mesh ref={ring} rotation-x={-Math.PI / 2} visible={false} renderOrder={2} raycast={() => null}>
        <ringGeometry args={[0.22, 0.26, 48]} />
        <meshBasicMaterial ref={ringMaterial} transparent opacity={0.9} depthWrite={false} toneMapped={false} />
      </mesh>
    </>
  );
}
