import { Component, Suspense, useEffect, useRef, useState } from 'react';
import { useFrame, useLoader, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { IfInSessionMode, XROrigin, useXR, useXRControllerLocomotion } from '@react-three/xr';
import * as THREE from 'three';
import { useControllerGrips } from './Grab.jsx';
import { XRMenuPanel } from './XRMenuPanel.jsx';
import { SideBySide } from './SideBySide.jsx';
import { Interlaced } from './Interlaced.jsx';
import { CameraBackground, CardboardRig } from './Cardboard.jsx';
import { GazeReticle } from './Gaze.jsx';
import { PhoneStereoXR } from './PhoneStereo.jsx';
import { DepthPassthrough } from './DepthPassthrough.jsx';
import { DepthSource } from './depth/DepthSource.jsx';
import { SOLID_BACKGROUND } from './menu.js';

// The windowed view looks at the space in front of where the session (or
// the test feed's camera) started, the origin of the room's coordinates.
export const ORBIT_TARGET = [0, 1, -1.5];
// Without VR controllers (hand tracking, phones) the XR panel starts off to
// the player's left, turned toward them, and travels with the player. Constants, so a re-render never undoes a move.
const MENU_POSITION = [-0.65, 1.05, -0.2];
const MENU_ROTATION = [0, 0.9, 0];
// a phone's stereo view is blurrier and smaller than a headset's: a bigger panel stays readable
const PHONE_STEREO_MENU_SCALE = 1.5;
// With VR controllers the panel rides on the left one, like a palette held in
// that hand: above the controller, tilted back toward the face, half size.
// The right controller's ray presses the panel's buttons. In grip space, -Z points forward out of the controller and +Y up
// out of its top.
const DOCK_POSITION = [0, 0.17, -0.02];
const DOCK_ROTATION = [-0.35, 0, 0];
const DOCK_SCALE = 0.5;

/**
 * Follows the left controller's grip each frame. A child of the XROrigin, so
 * the grip pose (relative to the session's reference space) applies as is.
 * Hidden while the controller isn't tracked.
 */
function LeftControllerDock({ children }) {
  const gl = useThree((s) => s.gl);
  const dock = useRef(null);
  useFrame((_, __, frame) => {
    const group = dock.current;
    if (!group) return;
    const referenceSpace = gl.xr.getReferenceSpace();
    const source = frame && [...frame.session.inputSources].find((s) => s.handedness === 'left' && s.gripSpace && !s.hand);
    const pose = source && referenceSpace && frame.getPose(source.gripSpace, referenceSpace);
    group.visible = Boolean(pose);
    if (pose) group.matrix.fromArray(pose.transform.matrix);
  });
  return (
    <group ref={dock} matrixAutoUpdate={false}>
      {children}
    </group>
  );
}

const SKY_URL = `${import.meta.env.BASE_URL}img/skybox.jpg`;

/** Renders `fallback` if a child throws, e.g. a texture that failed to download. */
class AssetBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error) {
    console.warn('[depth-xr] asset failed to load, continuing without it:', error.message);
  }
  render() {
    return this.state.failed ? this.props.fallback ?? null : this.props.children;
  }
}

function Sky({ passthrough }) {
  const texture = useLoader(THREE.TextureLoader, SKY_URL);
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);
  // passthrough only exists inside an AR session; elsewhere keep the sky
  const hidden = useXR((s) => passthrough && s.mode === 'immersive-ar');

  useEffect(() => {
    if (hidden) return;
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = gl.capabilities.getMaxAnisotropy();
    scene.background = texture;
    return () => {
      if (scene.background === texture) scene.background = null;
    };
  }, [texture, scene, gl, hidden]);

  return null;
}

const _eye = new THREE.Vector3();

/**
 * The solid colour as a sphere around the viewer. In an AR session three.js
 * clears to transparent whatever scene.background says (so passthrough shows),
 * so there the colour has to be drawn, like the skybox is.
 */
function SolidDome() {
  const dome = useRef(null);
  useFrame(({ camera }) => dome.current?.position.copy(camera.getWorldPosition(_eye)));
  return (
    <mesh ref={dome} renderOrder={-1000} frustumCulled={false} raycast={() => null}>
      <sphereGeometry args={[100, 16, 8]} />
      <meshBasicMaterial color={SOLID_BACKGROUND} side={THREE.BackSide} depthTest={false} depthWrite={false} toneMapped={false} />
    </mesh>
  );
}

/** Solid colour or the skybox; passthrough shows the skybox until an AR session hides it. */
function Backdrop({ background }) {
  const scene = useThree((s) => s.scene);
  const inAR = useXR((s) => s.mode === 'immersive-ar');
  const solid = background === 'solid';
  useEffect(() => {
    if (!solid || inAR) return;
    const color = new THREE.Color(SOLID_BACKGROUND);
    scene.background = color;
    return () => {
      if (scene.background === color) scene.background = null;
    };
  }, [solid, inAR, scene]);
  if (solid) return inAR ? <SolidDome /> : null;
  return (
    // own boundary so a slow or failed sky never holds back the scene
    <AssetBoundary>
      <Suspense fallback={null}>
        <Sky passthrough={background === 'passthrough'} />
      </Suspense>
    </AssetBoundary>
  );
}

const _head = new THREE.Vector3();

/**
 * Left thumbstick moves, right thumbstick turns smoothly about the head.
 * A grip on the panel carries it. The depth passthrough and the panel are
 * children of the player's origin, so they stay on the real room however
 * the player moves.
 */
function Player({ origin, menu, children }) {
  useXRControllerLocomotion(
    (velocity, turn, delta, state) => {
      const o = origin.current;
      if (!o) return;
      o.position.addScaledVector(velocity, delta);
      if (!turn) return;
      // swing the origin around the head so turning doesn't move the viewer
      state.camera.getWorldPosition(_head);
      const dx = o.position.x - _head.x;
      const dz = o.position.z - _head.z;
      const c = Math.cos(turn);
      const s = Math.sin(turn);
      o.position.x = _head.x + dx * c + dz * s;
      o.position.z = _head.z - dx * s + dz * c;
      o.rotation.y += turn;
    },
    { speed: 1.5 },
    { type: 'smooth', speed: 1.5 },
  );
  useControllerGrips({ menu, origin });
  return <XROrigin ref={origin}>{children}</XROrigin>;
}

/** A floor grid for the windowed view, for a sense of scale. */
function FloorGrid() {
  return <gridHelper args={[10, 20, '#5a6278', '#3a4052']} raycast={() => null} />;
}

/**
 * `testFeed`: the desktop test feed's <video> (Background → Test Feed), or
 * null. It stands in for a phone's camera outside XR.
 */
export default function Scene({ state, menu, phone, testFeed }) {
  const inSession = useXR((s) => s.mode === 'immersive-vr' || s.mode === 'immersive-ar');
  const inAR = useXR((s) => s.mode === 'immersive-ar');
  // a phone's AR session drawn as two lens-corrected eyes
  const phoneStereo = phone && inAR && state.stereo;
  // a phone has no controllers: a 1-second stare clicks the panel
  const hasControllers = useXR((s) => s.inputSourceStates.some((input) => input.type === 'controller'));
  const docked = useXR((s) =>
    s.inputSourceStates.some((input) => input.type === 'controller' && input.inputSource.handedness === 'left'),
  );
  const immersive = inSession || state.handheld;
  // the motion-sensor view has no AR session: passthrough is the rear camera
  const cameraPassthrough = state.handheld && state.passthrough;
  // the camera image in the room, true to scale with outfill: the phone's in AR, or the test feed's
  const cameraInRoom = (phone && inAR && state.passthrough) || Boolean(testFeed);
  const [cameraFailed, setCameraFailed] = useState(false);
  useEffect(() => setCameraFailed(false), [cameraPassthrough]);
  const origin = useRef(null);
  const menuPanel = useRef(null);

  return (
    <>
      {cameraPassthrough && !cameraFailed ? (
        <CameraBackground
          split={state.stereo}
          onError={(e) => {
            console.warn('[depth-xr] camera unavailable, showing the skybox instead:', e?.message ?? e);
            setCameraFailed(true);
          }}
        />
      ) : (
        <Backdrop background={state.background === 'testFeed' ? 'solid' : state.background} />
      )}
      {state.view === 'sbs' && !immersive && <SideBySide />}
      {state.view === 'interlaced' && !immersive && <Interlaced />}
      {phoneStereo && <PhoneStereoXR strength={state.strength} />}
      {!inSession && <FloorGrid />}
      <DepthSource mode={state.depthMode} video={testFeed} />
      <Player origin={origin} menu={menuPanel}>
        {cameraInRoom && <DepthPassthrough surface={state.depthMesh} />}
        {immersive &&
          (docked && inSession ? (
            // no groupRef: a docked panel can't be carried off by a grip
            <LeftControllerDock>
              <XRMenuPanel {...menu} position={DOCK_POSITION} rotation={DOCK_ROTATION} scale={DOCK_SCALE} />
            </LeftControllerDock>
          ) : (
            <XRMenuPanel
              {...menu}
              groupRef={menuPanel}
              position={MENU_POSITION}
              rotation={MENU_ROTATION}
              scale={phone && state.stereo ? PHONE_STEREO_MENU_SCALE : 1}
            />
          ))}
      </Player>
      {immersive && !hasControllers && <GazeReticle />}
      {state.handheld ? (
        <CardboardRig split={state.stereo} />
      ) : (
        <IfInSessionMode deny={['immersive-vr', 'immersive-ar']}>
          <OrbitControls makeDefault target={ORBIT_TARGET} enableDamping minDistance={0.3} maxDistance={20} />
        </IfInSessionMode>
      )}
    </>
  );
}
