import { useEffect } from 'react';
import { advance, useThree } from '@react-three/fiber';
import { useXR } from '@react-three/xr';

// Options → Display → VSync, as in grid-game-threejs and earth-threejs. On: a
// frame per display refresh. Off (outside XR): the next frame starts as soon
// as one is done (a message loop), so the frame rate isn't capped at the
// refresh rate; the browser still shows them at its own refreshes. An XR
// session, or a hidden page, always waits for its frames.

/** Paces rendering for VSync; mount inside the Canvas (and the XR provider). */
export function VSync({ vsync }) {
  const gl = useThree((s) => s.gl);
  const setFrameloop = useThree((s) => s.setFrameloop);
  const session = useXR((s) => s.session);

  // Off, outside XR: a frame as soon as the last is done. "Done" is the GPU's:
  // a fence after each frame, and the next waits for the one before last, so
  // no more than two are in flight. (Started as fast as JavaScript can,
  // frames pile up in the GPU's queue faster than it draws them: the page
  // stops repainting, and doesn't recover when VSync comes back on.)
  useEffect(() => {
    if (vsync || session) return;
    const context = gl.getContext();
    if (!context.fenceSync) return; // (WebGL 1: VSync stays on)
    setFrameloop('never');
    const loop = new MessageChannel();
    const fences = [];
    let running = true;
    loop.port1.onmessage = () => {
      if (!running) return;
      if (document.hidden) return void requestAnimationFrame(() => loop.port2.postMessage(0)); // (rests while hidden)
      if (fences.length >= 2) {
        if (context.clientWaitSync(fences[0], 0, 0) === context.TIMEOUT_EXPIRED) return void loop.port2.postMessage(0);
        context.deleteSync(fences.shift());
      }
      advance(performance.now());
      fences.push(context.fenceSync(context.SYNC_GPU_COMMANDS_COMPLETE, 0));
      context.flush();
      loop.port2.postMessage(0);
    };
    loop.port2.postMessage(0);
    return () => {
      running = false;
      loop.port1.close();
      for (const fence of fences) context.deleteSync(fence);
      setFrameloop('always');
    };
  }, [vsync, session, gl, setFrameloop]);

  return null;
}
