# Depth XR

Phone AR with depth: look around through an Android phone in a Cardboard-style viewer and see the camera image in stereo, with real parallax, through live video filters.

Live: https://lindblum.github.io/room-mesh-threejs/

## Where the depth comes from

A web page can't reconstruct depth from a Quest 2's cameras, but an Android phone in Chrome gives WebXR pages three things:

- **6DoF tracking** from ARCore.
- **The camera image** (`camera-access`).
- **ARCore depth** (`depth-sensing`) on most ARCore phones, estimated from the phone's motion, so no depth sensor is needed. It's metric but coarse (about 160×90).

On top of that, **Depth Anything V2 Small** runs on the camera image in a worker (onnxruntime-web, WebGPU), as in the 2D-3D video converter extension (youtube-3d-convert-addon). Its depth is sharp but relative, so it is scaled to metres against ARCore's depth or, without that, against hit tests on real surfaces. Every depth sample carries an uncertainty (sigma).

The depth becomes a surface in the room, coloured with the live camera image, so each eye of the viewer sees it from its own side. Everything is true to scale: the camera sees less than a viewer's lenses show, so beyond the camera's view a blurred outfill carries the image's edges out into the periphery, all the way round (or black, or the image stretched: Video → Periphery).

## Use

- **Video → View Mode → XR: Phone Viewer** for stereo in a viewer, or **XR: Phone AR** for one view.
- **Video → Filter**: Grayscale, Sepia, Invert, Posterize, Edges, Cartoon, Night Vision, Thermal, and three that need depth: Depth Colours, Depth Fog, Depth Outlines. `F` cycles them on a desktop.
- **Video → Periphery**: what the viewer shows beyond the camera's narrower view: Black, Outfill (the image's edges carried out, blurred), or Stretch (the image magnified to fill; turning then moves it a little fast).
- **Depth → Source**, the depth algorithm:
  - **Auto**: ARCore's depth, sharpened by Depth Anything V2 while it keeps up.
  - **ARCore**: ARCore's depth alone.
  - **Depth Anything V2 / V3, MiDaS**: depth models on the camera image (50 / 105 / 66 MB, downloaded once). Their depth is relative, so it's scaled to metres against ARCore's depth, or hit tests on surfaces, or an assumed range.
  - **Scene Cues**: lower, brighter, more saturated and more central reads as nearer. Instant, rough.
  - **Ground Plane**: every ray meets the floor. Metric, but only right for the floor.
  - **Motion Parallax**: points tracked between camera frames and triangulated with ARCore's known camera movement, like ARCore's own depth. Move the phone a few centimetres sideways. (On the desktop test feed, with no camera movement known, it reads depth from how far points move, as WiFi Camera Link does.) **Smoothing** averages depth over recent frames; real changes come through at once.
- **Depth → Depth Passthrough** off shows the camera image flat, at the scene's typical distance. **Stereo Strength** scales the eye separation (1× is true to scale).
- On a desktop, **Video → Background → Test Feed** runs the depth model on your webcam, or on a video file dropped on the page.

The model (50 MB) downloads from Hugging Face on first use and is cached by the browser.

## Develop

```sh
npm install
npm run dev      # localhost; use the Test Feed background
npm run dev:xr   # HTTPS on your LAN, for a phone (chrome://inspect for its console)
npm run build    # dist/; pushes to master deploy it to GitHub Pages
```
