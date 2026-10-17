import home from 'lineicons/assets/svgs/regular/home-2.svg?raw';
import brush from 'lineicons/assets/svgs/regular/brush-2.svg?raw';
import ruler from 'lineicons/assets/svgs/regular/ruler-1.svg?raw';
import download from 'lineicons/assets/svgs/regular/download-1.svg?raw';
import trash from 'lineicons/assets/svgs/regular/trash-3.svg?raw';
import arrowLeft from 'lineicons/assets/svgs/regular/arrow-left.svg?raw';
import arrowRight from 'lineicons/assets/svgs/regular/arrow-right.svg?raw';
import chevronDown from 'lineicons/assets/svgs/regular/chevron-down.svg?raw';
import chevronUp from 'lineicons/assets/svgs/regular/chevron-up.svg?raw';
import check from 'lineicons/assets/svgs/regular/check.svg?raw';
import gear from 'lineicons/assets/svgs/regular/gear-1.svg?raw';
import picture from 'lineicons/assets/svgs/regular/gallery.svg?raw';
import globe from 'lineicons/assets/svgs/regular/globe-1.svg?raw';

// Lineicons ship with a fixed fill; recolour to follow the surrounding text
// and size to the font.
const recolour = (svg) =>
  svg
    .replace(/fill="#323544"/g, 'fill="currentColor"')
    .replace(/\swidth="\d+"\sheight="\d+"/, ' width="1.25em" height="1.25em" aria-hidden="true"');

// The free Lineicons set has no VR headset (its "oculus" icon is the brand
// wordmark) and nothing for planes, meshes, occupancy grids or room scans,
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

// Solid background: a filled rectangle
const solid = `<svg width="1.25em" height="1.25em" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<rect x="2.75" y="5" width="18.5" height="14" rx="1.5" fill="currentColor" fill-opacity="0.35" stroke="currentColor" stroke-width="1.5"/>
</svg>`;

// Planes: two flat surfaces in perspective, a floor and a wall
const planes = `<svg width="1.25em" height="1.25em" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<path d="M2.75 17.5 8 13.25h13.25L16 17.5H2.75Z" fill="currentColor" fill-opacity="0.3" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
<path d="M8 13.25V3.75h13.25v9.5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
</svg>`;

// Mesh: a patch of triangles
const mesh = `<svg width="1.25em" height="1.25em" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<path d="M3 19.5 7.5 5l6 3.5L20.5 4l.5 15.5H3Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
<path d="M7.5 5 12 19.5l1.5-11 7.5 11M3 19.5l10.5-11" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" stroke-opacity="0.65"/>
</svg>`;

// Obstacle map: a grid seen from above, some cells blocked
const obstacles = `<svg width="1.25em" height="1.25em" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<rect x="3" y="3" width="18" height="18" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
<path d="M9 3v18M15 3v18M3 9h18M3 15h18" stroke="currentColor" stroke-width="1" stroke-opacity="0.5"/>
<path d="M9 3h6v6H9zM15 9h6v6h-6zM3 15h6v6H3z" fill="currentColor"/>
</svg>`;

// Room Setup: a box in a viewfinder's corners
const scan = `<svg width="1.25em" height="1.25em" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<path d="M3 8V4.5A1.5 1.5 0 0 1 4.5 3H8M16 3h3.5A1.5 1.5 0 0 1 21 4.5V8M21 16v3.5a1.5 1.5 0 0 1-1.5 1.5H16M8 21H4.5A1.5 1.5 0 0 1 3 19.5V16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
<path d="m12 7 4.5 2.5v5L12 17l-4.5-2.5v-5L12 7Zm0 5 4.5-2.5M12 12v5m0-5L7.5 9.5" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
</svg>`;

// Scan: a controller's tip on a point, in a crosshair
const probe = `<svg width="1.25em" height="1.25em" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<circle cx="12" cy="12" r="6.25" stroke="currentColor" stroke-width="1.5"/>
<circle cx="12" cy="12" r="1.75" fill="currentColor"/>
<path d="M12 2.75v3M12 18.25v3M2.75 12h3M18.25 12h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
</svg>`;

// Scan → Points: a traced stroke of dots
const points = `<svg width="1.25em" height="1.25em" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<circle cx="4.5" cy="17" r="1.6" fill="currentColor"/>
<circle cx="8.5" cy="12.5" r="1.6" fill="currentColor"/>
<circle cx="12.5" cy="11" r="1.6" fill="currentColor"/>
<circle cx="16" cy="7.5" r="1.6" fill="currentColor"/>
<circle cx="19.5" cy="5" r="1.6" fill="currentColor"/>
<circle cx="15" cy="17.5" r="1.6" fill="currentColor" fill-opacity="0.5"/>
</svg>`;

// Scan → Box: a box
const box = `<svg width="1.25em" height="1.25em" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<path d="m12 3 8.25 4.5v9L12 21l-8.25-4.5v-9L12 3Zm0 9 8.25-4.5M12 12v9m0-9L3.75 7.5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
</svg>`;

// Box Label: a tag
const tag = `<svg width="1.25em" height="1.25em" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<path d="M3.75 4.75v6.3a1.5 1.5 0 0 0 .44 1.06l8.2 8.2a1.5 1.5 0 0 0 2.12 0l5.8-5.8a1.5 1.5 0 0 0 0-2.12l-8.2-8.2a1.5 1.5 0 0 0-1.06-.44h-6.3a1 1 0 0 0-1 1Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
<circle cx="8.25" cy="8.25" r="1.5" fill="currentColor"/>
</svg>`;

// Undo: an arrow curving back
const undo = `<svg width="1.25em" height="1.25em" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<path d="M8.5 5 4 9.5 8.5 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M4 9.5h10.25a5.75 5.75 0 0 1 0 11.5H11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
</svg>`;

const ICONS = {
  room: recolour(home),
  planes,
  mesh,
  style: recolour(brush),
  obstacles,
  ruler: recolour(ruler),
  scan,
  probe,
  points,
  box,
  tag,
  undo,
  download: recolour(download),
  clear: recolour(trash),
  video,
  // Back, and its mirror marking a button that opens a submenu
  back: recolour(arrowLeft),
  forward: recolour(arrowRight),
  // a dropdown, closed and open, and the chosen option in its list
  dropdown: recolour(chevronDown),
  dropdownOpen: recolour(chevronUp),
  check: recolour(check),
  gear: recolour(gear),
  solid,
  skybox: recolour(globe),
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
