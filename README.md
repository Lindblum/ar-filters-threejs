# Room Mesh

An experiment in room-aware AR on a Quest: read the room the headset knows about over WebXR, draw it over passthrough, and turn it into a top-down obstacle map you can query ("how far is the nearest thing I could walk into?").

It is `xr-music-threejs` with the fretboard, audio and music menus taken out. The shell is unchanged: Vite, React, [@react-three/fiber](https://r3f.docs.pmnd.rs), [@react-three/xr](https://pmndrs.github.io/xr/), the windowed and XR panels, the backgrounds, the view modes (3D: SBS, 3D: Interlaced, phone AR and phone viewer), locomotion and carrying the panel with a grip.

## Where the room comes from (and what a Quest 2 can do)

WebXR on a Quest does **not** give pages the camera images, and a Quest 2 has no depth sensor, so a web page can't reconstruct a mesh from the cameras itself. What the Quest Browser does expose is the room model from the headset's **Space Setup**:

| WebXR feature | What you get | Quest 2 | Quest 3 / 3S |
| --- | --- | --- | --- |
| `plane-detection` | Flat polygons labelled floor, ceiling, wall, door, window, table… | Yes, from the walls and furniture you draw in Space Setup | Yes, from the automatic scan |
| `mesh-detection` | Triangle meshes: furniture volumes, and the scanned "global mesh" of the room | Furniture volumes at most; no scanned mesh | Yes, including the global mesh |
| `bounded-floor` | The guardian boundary polygon | Often missing in passthrough | Often missing in passthrough |
| `depth-sensing` | Per-frame depth | No | Yes (not used here yet) |

So on a Quest 2 the "mesh" is as good as the room you draw in Space Setup. **Room Setup** in the Room menu opens Space Setup from inside the session (Quest Browser only). The panel's first line in XR says which of these features the session was actually granted.

## Touch-to-scan

What a Quest 2 *can* measure precisely is where its controllers are: to a few millimetres. So the **Scan** menu turns the right controller into a probe: hold its tip against a real surface and pull the trigger to record a 3D point there, in the same coordinates as everything else. A small sphere marks the tip; a haptic tick confirms each point.

| Mode | Trigger | A | Builds |
| --- | --- | --- | --- |
| **Points** | Click: one point. Hold: trace a stroke, a point every 1 cm | — | A point cloud, for anything irregular |
| **Walls** | One press per room corner, in order, at any height | Build | Walls straight up through the corners. Three or more close the loop and add a floor and a ceiling. They're 2.4 m tall unless you touch one corner up near the ceiling (over 1.8 m), which sets the height |
| **Box** | Three or more points on an object's top, its corners say | Build | A box turned to fit the points, from the floor up to the highest one, labelled by **Box Label**. Touch a bottom corner too (over 10 cm lower) and it spans just between them, for a wall cabinet or a table top |

**B** undoes the last point, or else the last shape. Scanned surfaces feed the obstacle map, the pointer probe and **Export Room (.glb)** like the headset's own; **Scans** shows or hides them, **Clear Scans** drops them.

**Calibrate Tip** once per controller, for millimetre points: choose it, put the controller's tip on one fixed spot (a table corner), hold the trigger and swivel the controller around that spot for a few seconds, keeping the tip still. It solves for where the tip is in the controller and remembers it in this browser. Until then the tip is where the controller's ray starts, which can be a couple of centimetres off.

The panel shows the tip's height above the floor and its distance from the last point, so it doubles as a tape measure. A new session starts a new room (its origin is wherever the headset started), so **export before leaving XR** if you want to keep a scan.

## Develop

```sh
npm install
npm run dev        # http://localhost:5175. A Quest 3 emulator with a sample room stands in for a headset on localhost
npm run dev:xr     # HTTPS on your LAN, so a real headset can connect
```

On localhost, choose **Video → View Mode → XR: Headset**: the emulator starts an AR session in a synthetic office that reports planes and meshes like a real Quest.

## Build a static site

```sh
npm run build      # writes dist/ with relative paths, so any static host or subfolder works
npm run preview
```

`.github/workflows/deploy.yml` publishes `dist/` to GitHub Pages on every push to `master`.

## What you see

- **Room surfaces**, coloured by label (walls orange, floor blue, tables green, couches purple…), as wireframe, solid, or **occlusion** (invisible, but hides virtual things behind real ones).
- **Obstacle map** on the floor: a top-down grid where anything between 10 cm and 2 m above the floor is an obstacle (red), the 30 cm around obstacles is a caution zone (amber), and floor with nothing over it is free (blue). Unknown space is clear.
- **Proximity ring** under you, blue / amber / red by your distance to the nearest obstacle, which the panel also shows in metres.
- **Pointer probe**: point a controller (or the mouse) at any surface for a marker on it, with its label and distance on the panel.
- The **guardian boundary**, as a cyan line, if the session reports one.

The room is kept after the session ends, so you can leave XR and orbit around it on the monitor, or **Export Room (.glb)** for Blender and the like (each surface a node named by its label, in metres, y up, origin where the session started).

## Controls

| Action | Desktop | XR |
| --- | --- | --- |
| Planes / Meshes on or off | Room, `P` / `M` | Room |
| Style: Wireframe / Solid / Occlusion | Room, `Y` | Room |
| Obstacle map on or off; cell size 5 / 10 / 20 cm | Room, `O` | Room |
| Probe a surface | Hover over it | Point the controller ray at it |
| Scan: mode, box label, build, undo, calibrate | Scan | Scan; then the right trigger records, A builds, B undoes |
| Room Setup (Space Setup) | — | Room (Quest Browser) |
| Export the room as .glb | Room, `X` | Room |
| Clear Room | Room | Room: the session refills it from the headset |
| Show / hide the panel | Gear button, `Enter`, `Esc` | Gear on the panel |
| Orbit / zoom | Drag / scroll | Walk around. The left stick moves you and the right stick turns you |
| The panel in XR | — | With controllers it rides on the left one; press with the right controller's ray. Without them it floats to your left; point at it and hold the grip to move it |
| Background, View Mode | Video, as in xr-music | Video |

## Layout

- `src/App.jsx`: app state, keyboard shortcuts, the HUD, session options and the status lines
- `src/Scene.jsx`: backdrop, lights, locomotion, the panel, and the room layers inside the XR origin
- `src/room.js`: the room snapshot, label colours, the obstacle grid and its distance field, and .glb export
- `src/Room.jsx`: `RoomSensor` (reads the session's planes, meshes and boundary each few frames), `RoomModel`, `ObstacleMap`, `ProbeMarker`, `BoundsOutline`
- `src/scan.js`: touch-to-scan: the scan in progress, building walls, boxes and point clouds from it, Undo, and tip calibration
- `src/Scan.jsx`: `Scanner`, which reads the right controller, records points and draws the scan in progress
- `src/menu.js`: the options menu, its Room and Video submenus and dropdowns, shared by both panels
- `src/XRMenuPanel.jsx`, `src/Icon.jsx`, `src/Gaze.jsx`, `src/Grab.jsx`, `src/grip.js`: the XR panel, its icons, gaze dwell-to-click, and carrying the panel
- `src/SideBySide.jsx`, `src/Interlaced.jsx`, `src/PhoneStereo.jsx`, `src/Cardboard.jsx`, `src/CardboardLens.js`: the view modes, from xr-music

## Ideas for next steps

- On a Quest 3, add `depth-sensing` for live occlusion and to catch things Space Setup doesn't know about (people, a chair you moved).
- Keep the obstacle map and scans across sessions with anchors, so a second visit doesn't depend on where the headset started.
- More scan shapes: a flat surface from three or more points on it (a table top, a door), or walls snapped square.
