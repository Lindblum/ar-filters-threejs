import { Component, Suspense, useEffect, useRef, useState } from 'react';
import { useFrame, useLoader, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { IfInSessionMode, XROrigin, useXR, useXRControllerLocomotion } from '@react-three/xr';
import * as THREE from 'three';
import { XRPanels } from './XRPanels.jsx';
import { holding } from './grip.js';
import { SideBySide } from './SideBySide.jsx';
import { Interlaced } from './Interlaced.jsx';
import { CameraBackground, CardboardRig } from './Cardboard.jsx';
import { GazeReticle } from './Gaze.jsx';
import { PhoneStereoXR } from './PhoneStereo.jsx';
import { DepthPassthrough } from './DepthPassthrough.jsx';
import { DepthSource } from './depth/DepthSource.jsx';
import { ControllerGuide } from './ControllerGuide.jsx';

// The windowed view looks at the space in front of where the session started, the origin of the room's coordinates.
export const ORBIT_TARGET = [0, 1, -1.5];
const SKY_URL = `${import.meta.env.BASE_URL}img/skybox.jpg`;

/** Renders `fallback` if a child throws, e.g. a texture that failed to download. */
class AssetBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error) {
    console.warn('[ar-filters] asset failed to load, continuing without it:', error.message);
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

/** The skybox, until an AR session's passthrough hides it. */
function Backdrop({ background }) {
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
 * Left thumbstick moves, right thumbstick turns smoothly about the head; a
 * hand holding a panel pushes and turns that instead (see XRPanels). The
 * depth passthrough and the panels are children of the player's origin, so
 * they stay on the real room however the player moves.
 */
function Player({ origin, children }) {
  useXRControllerLocomotion(
    (velocity, turn, delta, state) => {
      const o = origin.current;
      if (!o) return;
      if (holding.right) turn = 0;
      if (!holding.left) o.position.addScaledVector(velocity, delta);
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
  return <XROrigin ref={origin}>{children}</XROrigin>;
}

/** A floor grid for the windowed view, for a sense of scale. */
function FloorGrid() {
  return <gridHelper args={[10, 20, '#5a6278', '#3a4052']} raycast={() => null} />;
}

export default function Scene({ state, panels, onSelect, phone }) {
  const inSession = useXR((s) => s.mode === 'immersive-vr' || s.mode === 'immersive-ar');
  const inAR = useXR((s) => s.mode === 'immersive-ar');
  // a phone's AR session drawn as two lens-corrected eyes
  const phoneStereo = phone && inAR && state.stereo;
  // a phone has no controllers: a 1-second stare clicks the panel
  const hasControllers = useXR((s) => s.inputSourceStates.some((input) => input.type === 'controller'));
  const immersive = inSession || state.handheld;
  // the motion-sensor view has no AR session: passthrough is the rear camera
  const cameraPassthrough = state.handheld && state.passthrough;
  // the phone's camera image in the room, true to scale with outfill
  const cameraInRoom = phone && inAR && state.passthrough;
  const [cameraFailed, setCameraFailed] = useState(false);
  useEffect(() => setCameraFailed(false), [cameraPassthrough]);
  const origin = useRef(null);

  return (
    <>
      {cameraPassthrough && !cameraFailed ? (
        <CameraBackground
          split={state.stereo}
          onError={(e) => {
            console.warn('[ar-filters] camera unavailable, showing the skybox instead:', e?.message ?? e);
            setCameraFailed(true);
          }}
        />
      ) : (
        <Backdrop background={state.background} />
      )}
      {state.view === 'sbs' && !immersive && <SideBySide />}
      {state.view === 'interlaced' && !immersive && <Interlaced />}
      {phoneStereo && <PhoneStereoXR strength={state.strength} convergence={state.convergence} zoom={state.zoom} />}
      {!inSession && <FloorGrid />}
      <DepthSource mode={state.depthMode} smoothing={state.smoothing} />
      <Player origin={origin}>
        {cameraInRoom && <DepthPassthrough surface={state.depthMesh} outfill={state.periphery !== 'black'} />}
        {immersive && !state.domMenu && (
          <XRPanels panels={panels} onSelect={onSelect} textScale={state.textSize} phoneStereo={phone && state.stereo} />
        )}
      </Player>
      {immersive && !hasControllers && !state.domMenu && <GazeReticle />}
      {inSession && <ControllerGuide on={state.controllerGuide} textScale={state.textSize} />}
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
