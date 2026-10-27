import download from 'lineicons/assets/svgs/regular/download-1.svg?raw';
import trash from 'lineicons/assets/svgs/regular/trash-3.svg?raw';
import chevronDown from 'lineicons/assets/svgs/regular/chevron-down.svg?raw';
import chevronUp from 'lineicons/assets/svgs/regular/chevron-up.svg?raw';
import check from 'lineicons/assets/svgs/regular/check.svg?raw';
import gear from 'lineicons/assets/svgs/regular/gear-1.svg?raw';
import picture from 'lineicons/assets/svgs/regular/gallery.svg?raw';
import camera from 'lineicons/assets/svgs/regular/camera-1.svg?raw';
import flowchart from 'lineicons/assets/svgs/regular/vector-nodes-7.svg?raw';
import eye from 'lineicons/assets/svgs/regular/eye.svg?raw';
import palette from 'lineicons/assets/svgs/regular/colour-palette-3.svg?raw';
import layers from 'lineicons/assets/svgs/regular/layers-1.svg?raw';
import searchPlus from 'lineicons/assets/svgs/regular/search-plus.svg?raw';

// Lineicons ship with a fixed fill; recolour to follow the surrounding text
// and size to the font.
const recolour = (svg) =>
  svg
    .replace(/fill="#323544"/g, 'fill="currentColor"')
    .replace(/\swidth="\d+"\sheight="\d+"/, ' width="1.25em" height="1.25em" aria-hidden="true"');

// The free Lineicons set has no VR headset (its "oculus" icon is the brand
// wordmark) and nothing for meshes or point clouds,
// so these are drawn to match: 24px grid, 1.5px rounded strokes.
const headset = `<svg width="1.25em" height="1.25em" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<path d="M5.5 7h13A2.5 2.5 0 0 1 21 9.5v5a2.5 2.5 0 0 1-2.5 2.5h-3.13a1.5 1.5 0 0 1-1.3-.76l-.77-1.35a1.5 1.5 0 0 0-2.6 0l-.77 1.35a1.5 1.5 0 0 1-1.3.76H5.5A2.5 2.5 0 0 1 3 14.5v-5A2.5 2.5 0 0 1 5.5 7Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
<path d="M3 11.5H1.75M21 11.5h1.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
</svg>`;

const monitor = `<svg width="1.25em" height="1.25em" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<rect x="2.75" y="4.25" width="18.5" height="12" rx="1.75" stroke="currentColor" stroke-width="1.5"/>
<path d="M12 16.25v3.5M8.5 19.75h7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
</svg>`;

// 3D: SBS: the screen split in two, an eye in each half
const monitorSbs = monitor.replace(
  '</svg>',
  `<path d="M12 6v8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
<circle cx="7.4" cy="10.25" r="1.4" fill="currentColor"/>
<circle cx="16.6" cy="10.25" r="1.4" fill="currentColor"/>
</svg>`,
);

// 3D: Interlaced: the screen in alternating rows
const monitorInterlaced = monitor.replace(
  '</svg>',
  `<path d="M5.5 7.25h13M5.5 10.25h13M5.5 13.25h13" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
<path d="M5.5 8.75h13M5.5 11.75h13" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-opacity="0.4"/>
</svg>`,
);

// Phone views: a phone, and a phone turned sideways in a viewer (two lenses)
const phone = `<svg width="1.25em" height="1.25em" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<rect x="6.75" y="2.75" width="10.5" height="18.5" rx="2" stroke="currentColor" stroke-width="1.5"/>
<path d="M10.75 18.25h2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
</svg>`;

const phoneViewer = `<svg width="1.25em" height="1.25em" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<rect x="2.75" y="6.75" width="18.5" height="10.5" rx="2" stroke="currentColor" stroke-width="1.5"/>
<path d="M12 6.75v10.5" stroke="currentColor" stroke-width="1.5"/>
<circle cx="7.4" cy="12" r="2.1" stroke="currentColor" stroke-width="1.5"/>
<circle cx="16.6" cy="12" r="2.1" stroke="currentColor" stroke-width="1.5"/>
</svg>`;

// Video: the screen playing
const video = monitor.replace(
  '</svg>',
  `<path d="M10.25 7.6v5.3l4.4-2.65-4.4-2.65Z" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/>
</svg>`,
);

// Mesh: a patch of triangles
const mesh = `<svg width="1.25em" height="1.25em" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<path d="M3 19.5 7.5 5l6 3.5L20.5 4l.5 15.5H3Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
<path d="M7.5 5 12 19.5l1.5-11 7.5 11M3 19.5l10.5-11" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" stroke-opacity="0.65"/>
</svg>`;

// Convergence: two sight lines meeting at a point
const convergence = `<svg width="1.25em" height="1.25em" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<path d="M3.5 5.5 18 12 3.5 18.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="19.5" cy="12" r="2" fill="currentColor"/>
</svg>`;

// Smoothing: a jagged line, and the smooth curve through it
const smoothing = `<svg width="1.25em" height="1.25em" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<path d="M2.5 14 5 9l2.5 7L10 7l2.5 9 2.5-8 2.5 7L20 9l1.5 4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="0.45"/>
<path d="M2.5 13c3-2.5 5-2.5 9.5 0s6.5 2.5 9.5 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
</svg>`;

// Points: a scatter of dots, for the point cloud
const points = `<svg width="1.25em" height="1.25em" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<circle cx="4.5" cy="17" r="1.6" fill="currentColor"/>
<circle cx="8.5" cy="12.5" r="1.6" fill="currentColor"/>
<circle cx="12.5" cy="11" r="1.6" fill="currentColor"/>
<circle cx="16" cy="7.5" r="1.6" fill="currentColor"/>
<circle cx="19.5" cy="5" r="1.6" fill="currentColor"/>
<circle cx="15" cy="17.5" r="1.6" fill="currentColor" fill-opacity="0.5"/>
</svg>`;

// Accessibility, as in grid-game-threejs: a figure with open arms in a circle
const accessibility = `<svg width="1.25em" height="1.25em" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<circle cx="12" cy="12" r="9.6" stroke="currentColor" stroke-width="1.5"/>
<circle cx="12" cy="6.5" r="1.5" fill="currentColor"/>
<path d="M6.25 9.6h11.5M12 9.6v4.3M9.1 18.7l2.9-4.8 2.9 4.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// Text Size: a small and a large "A"
const textSize = `<svg width="1.25em" height="1.25em" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<path d="M2.9 18.7 6.25 10.1l3.35 8.6M4.3 15.4h3.9M11 19.2 16.1 4.8l5.05 14.4M13 13.9h6.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// Vibration: a controller's handle with buzz lines either side, or still and struck through
const handle = `<rect x="9.1" y="4.3" width="5.8" height="15.4" rx="1.5" stroke="currentColor" stroke-width="1.5"/>`;
const vibrationOn = `<svg width="1.25em" height="1.25em" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
${handle}
<path d="m5.75 7.7-1.45 2.4 1.45 2.4-1.45 2.4M18.25 7.7l1.45 2.4-1.45 2.4 1.45 2.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
const vibrationOff = `<svg width="1.25em" height="1.25em" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
${handle}
<path d="M4.3 20.2 19.7 3.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
</svg>`;

// Controller Guide: a controller's handle with a button and a label tag pointing at it, or struck through
const guideHandle = `<rect x="3.35" y="7.2" width="6.7" height="13.9" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
<circle cx="6.7" cy="10.6" r="1.45" fill="currentColor"/>`;
const controllerGuideOn = `<svg width="1.25em" height="1.25em" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
${guideHandle}
<path d="M8.4 10.6 13.4 7.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
<rect x="13.4" y="4.3" width="8.2" height="5.8" rx="1.25" stroke="currentColor" stroke-width="1.5"/>
</svg>`;
const controllerGuideOff = `<svg width="1.25em" height="1.25em" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
${guideHandle}
<path d="M12 20.6 21.6 3.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
</svg>`;

const ICONS = {
  layers: recolour(layers),
  camera: recolour(camera),
  // Depth → Algorithm: a flowchart
  algorithm: recolour(flowchart),
  eye: recolour(eye),
  filter: recolour(palette),
  zoom: recolour(searchPlus),
  mesh,
  points,
  convergence,
  smoothing,
  download: recolour(download),
  clear: recolour(trash),
  video,
  accessibility,
  textSize,
  vibrationOn,
  vibrationOff,
  controllerGuideOn,
  controllerGuideOff,
  // a section or dropdown, closed and open, and the chosen option in its list
  dropdown: recolour(chevronDown),
  dropdownOpen: recolour(chevronUp),
  check: recolour(check),
  gear: recolour(gear),
  passthrough: recolour(picture),
  monitor,
  monitorSbs,
  monitorInterlaced,
  vr: headset,
  phone,
  phoneViewer,
};

/** An icon as a standalone SVG in a fixed colour, for drawing onto a canvas. */
export function iconSvg(name, color = '#ffffff') {
  return (ICONS[name] ?? '')
    .replace(/currentColor/g, color)
    .replace(/width="1\.25em" height="1\.25em"/, 'width="96" height="96"');
}

export default function Icon({ name }) {
  return <span className="icon" dangerouslySetInnerHTML={{ __html: ICONS[name] }} />;
}
