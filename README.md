# Depth XR

Phone AR with depth: look around through an Android phone in a Cardboard-style viewer and see the camera image in stereo, with real parallax, through live video filters.

Live: https://lindblum.github.io/room-mesh-threejs/

## Where the depth comes from

A web page can't reconstruct depth from a Quest 2's cameras, but an Android phone in Chrome gives WebXR pages three things:

- **6DoF tracking** from ARCore.
- **The camera image** (`camera-access`).
- **ARCore depth** (`depth-sensing`) on most ARCore phones, estimated from the phone's motion, so no depth sensor is needed. It's metric but coarse (about 160×90).

On top of that, **Depth Anything V2 Small** runs on the camera image in a worker (onnxruntime-web, WebGPU), as in the 2D-3D video converter extension (youtube-3d-convert-addon). Its depth is sharp but relative, so it is scaled to metres against ARCore's depth or, without that, against hit tests on real surfaces. Every depth sample carries an uncertainty (sigma).

The depth becomes a surface in the room, coloured with the live camera image, so each eye of the viewer sees it from its own side. The flat camera image fills in behind it.

## Use

- **Video → View Mode → XR: Phone Viewer** for stereo in a viewer, or **XR: Phone AR** for one view.
- **Video → Filter**: Grayscale, Sepia, Invert, Posterize, Edges, Cartoon, Night Vision, Thermal, Pixelate, and three that need depth: Depth Colours, Depth Fog, Depth Outlines. `F` cycles them on a desktop.
- **Depth → Source**: Auto (ARCore, sharpened by the model while it keeps up), ARCore, ML Model, or Off.
- **Depth → Depth Passthrough** off shows the camera flat, as before. **Stereo Strength** scales the eye separation (1× is true to scale).
- On a desktop, **Video → Background → Test Feed** runs the depth model on your webcam, or on a video file dropped on the page.

The model (50 MB) downloads from Hugging Face on first use and is cached by the browser.

## Develop

```sh
npm install
npm run dev      # localhost; use the Test Feed background
npm run dev:xr   # HTTPS on your LAN, for a phone (chrome://inspect for its console)
npm run build    # dist/; pushes to master deploy it to GitHub Pages
```
