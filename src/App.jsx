import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Canvas } from '@react-three/fiber';
import { XR, createXRStore, useXRSessionModeSupported } from '@react-three/xr';
import Scene from './Scene.jsx';
import { sideBySideEvents } from './SideBySide.jsx';
import Icon from './Icon.jsx';
import { MENU_TOGGLE } from './XRMenuPanel.jsx';
import { PHONE_AR_SESSION_INIT } from './PhoneStereo.jsx';
import { CardboardOverlay, canUseCardboard, enterCardboard, exitCardboard } from './Cardboard.jsx';
import { useRoomVersion } from './Room.jsx';
import { clearRoom, exportRoomGLB, getRoom, roomSummary } from './room.js';
import {
  ACTIONS,
  CELL_SIZES,
  DROPDOWNS,
  STYLES,
  TOGGLES,
  XR_VIEWS,
  MENU_ROWS,
  availableViews,
  PAGE_PREFIX,
  PICK_PREFIX,
  cycle,
  menuItems,
  menuTitle,
  dropdownChoices,
  possibleLabels,
  splitLabel,
} from './menu.js';

// View Mode: Normal, 3D: SBS (half side-by-side, for 3D TVs and projectors)
// and 3D: Interlaced (alternate rows, for passive 3D monitors) are windowed.
// The XR views start a session, only from a tap, as browsers require, as in
// the 4D viewer:
//   XR: Headset (headsets) starts an AR session where supported (so every
//   background, passthrough included, can be switched live), otherwise VR.
//   It asks for the headset's room model: planes, meshes, hit testing and
//   the guardian boundary.
//   XR: Phone AR / Phone Viewer start one AR session (tracked by ARCore) that
//   the app draws as one view, or two lens-corrected eyes for a phone viewer;
//   switching between the two is live. Phones without AR get a view steered
//   by the motion sensors instead, with the rear camera for passthrough.

// kept as a reference: the store reads it whenever a session starts
const xrOptions = {
  // controllers and hands get ray / touch pointers by default, for the panel and the probe
  frameRate: 'high',
  // headset emulator on localhost during development only; it loads a sample room
  emulate: import.meta.env.DEV ? 'metaQuest3' : false,
  foveation: 0.5,
};
const store = createXRStore(xrOptions);

/**
 * The headset session's options: the library's defaults plus the guardian
 * boundary (bounded-floor). All optional, so a headset without one of them
 * still starts, and the panel says which were granted.
 */
const HEADSET_SESSION_INIT = {
  requiredFeatures: ['local-floor'],
  optionalFeatures: ['plane-detection', 'mesh-detection', 'hit-test', 'anchors', 'bounded-floor', 'hand-tracking', 'layers'],
};

/** Starts a session with `init` in place of the library's options. */
function enterWith(init, enter) {
  xrOptions.customSessionInit = init;
  try {
    return enter(); // session options are built synchronously here
  } finally {
    xrOptions.customSessionInit = undefined;
  }
}

/** A headset's own browser (Quest, Pico, Wolvic). */
function isHeadsetBrowser() {
  return /OculusBrowser|Quest|Pico|Wolvic/i.test(navigator.userAgent);
}

/**
 * Phones and tablets, whose WebXR shows a single view. Detected by the
 * device rather than by WebXR support: some phone browsers also report VR.
 */
function isPhone() {
  if (isHeadsetBrowser()) return false;
  return /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) && canUseCardboard();
}

const describe = (e) => `${e?.name ?? 'Error'}${e?.message ? ` - ${e.message}` : ''}`;

function useRoomState() {
  const [planes, setPlanes] = useState(true);
  const [meshes, setMeshes] = useState(true);
  const [style, setStyle] = useState(STYLES[0]);
  const [obstacles, setObstacles] = useState(true);
  const [cell, setCell] = useState(CELL_SIZES[1]);
  const [background, setBackground] = useState('passthrough'); // 'solid' | 'skybox' | 'passthrough'
  const [menuOpen, setMenuOpen] = useState(true); // shared by the windowed and XR panels
  const [page, setPage] = useState('main'); // the submenu showing, see menu.js
  const [dropdown, setDropdown] = useState(null); // the dropdown whose list is open

  const actions = useMemo(
    () => ({
      toggle: (id) => ({ planes: setPlanes, meshes: setMeshes, obstacles: setObstacles })[id]((v) => !v),
      nextStyle: (step = 1) => setStyle((s) => cycle(STYLES, s, step)),
      toggleMenu: () => setMenuOpen((v) => !v),
      setPage: (p) => {
        setPage(p);
        setDropdown(null);
      },
      toggleDropdown: (id) => setDropdown((d) => (d === id ? null : id)),
      closeDropdown: () => setDropdown(null),
      /** A choice from a dropdown's list (see dropdownChoices), which then closes. */
      pick: (id, choice) => {
        ({ style: setStyle, cell: setCell, background: setBackground })[id](choice);
        setDropdown(null);
      },
    }),
    [],
  );
  const state = { planes, meshes, style, obstacles, cell, background, menuOpen, page, dropdown };
  return [state, actions];
}

function useKeyboard(actions, runAction) {
  const latest = useRef(runAction);
  latest.current = runAction;
  useEffect(() => {
    const keymap = {
      KeyP: () => actions.toggle('planes'),
      KeyM: () => actions.toggle('meshes'),
      KeyO: () => actions.toggle('obstacles'),
      KeyY: actions.nextStyle,
      KeyX: () => latest.current('export'),
      Enter: actions.toggleMenu,
      NumpadEnter: actions.toggleMenu,
      Escape: actions.toggleMenu,
    };
    const onKey = (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, select, textarea')) return;
      const action = keymap[e.code];
      if (!action) return;
      e.preventDefault();
      action(e.shiftKey ? -1 : 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions]);
}

function useXRSupport() {
  const vr = useXRSessionModeSupported('immersive-vr');
  const ar = useXRSessionModeSupported('immersive-ar');
  return { vr, ar, checked: vr !== undefined || ar !== undefined };
}

const getSession = () => store.getState().session ?? null;
const getSessionMode = () => store.getState().mode ?? null;

/** "Name: Value": the name on the left, the value against the right edge. */
function Label({ text }) {
  const { name, value } = splitLabel(text);
  return (
    <span className="label">
      <span className="name">{value ? `${name}:` : name}</span>
      {value && <span className="value">{value}</span>}
    </span>
  );
}

/** What a button's right edge shows: an arrow to a submenu, or a dropdown's chevron. */
function trailingIcon(item) {
  if (item.submenu) return 'forward';
  if (item.dropdown) return item.dropdown.open ? 'dropdownOpen' : 'dropdown';
  return null;
}

function MenuButtons({ items, labels, onSelect }) {
  return (
    <div className="menu-items">
      {items.map((item) => {
        const trailing = trailingIcon(item);
        return (
          <Fragment key={item.id}>
            <button
              className="menu-btn"
              disabled={item.disabled}
              title={item.title}
              aria-expanded={item.dropdown ? item.dropdown.open : undefined}
              onClick={() => onSelect(item.id)}
            >
              <Icon name={item.icon} />
              <Label text={item.label} />
              {trailing && <Icon name={trailing} />}
            </button>
            {item.dropdown?.open && (
              <div className="menu-options" role="listbox">
                {item.dropdown.options.map((option) => (
                  <button
                    key={option.id}
                    className={`menu-option${option.selected ? ' selected' : ''}`}
                    role="option"
                    aria-selected={option.selected}
                    onClick={() => onSelect(option.id)}
                  >
                    {option.icon && <Icon name={option.icon} />}
                    <span className="option-label">{option.label}</span>
                    {option.selected && <Icon name="check" />}
                  </button>
                ))}
              </div>
            )}
          </Fragment>
        );
      })}
      {/* invisible, zero-height copies of every possible label: they set the panel's width */}
      <div className="menu-sizer" aria-hidden="true">
        {labels.map((label) => (
          <div key={label} className="menu-btn">
            <Icon name="room" />
            <Label text={label} />
            <Icon name="dropdown" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The windowed panel: draws the shared menu model (see XRMenuPanel for XR). */
function Hud({ menu, notes }) {
  const toggle = () => menu.onSelect(MENU_TOGGLE);
  if (!menu.open) {
    return (
      <button className="hud-gear" onClick={toggle} aria-label="Show options" title="Options">
        <Icon name="gear" />
      </button>
    );
  }
  return (
    <aside className="hud">
      <header>
        <button className="collapse" onClick={toggle} aria-label="Hide options">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M3 9l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <h1>{menu.title}</h1>
      </header>

      <div className="hud-body">
        {menu.status.map((line) => (
          <p key={line} className="stats">
            {line}
          </p>
        ))}
        <MenuButtons items={menu.items} labels={menu.labels} onSelect={menu.onSelect} />
        {notes.map(({ text, error }) => (
          <p key={text} className={error ? 'note error' : 'note'} role={error ? 'alert' : undefined}>
            {text}
          </p>
        ))}
      </div>
    </aside>
  );
}

// which session features the panel reports, and how it names them
const FEATURE_NAMES = { 'plane-detection': 'planes', 'mesh-detection': 'meshes', 'hit-test': 'hit test', 'bounded-floor': 'boundary' };

/** The status lines both panels show above the buttons. */
function statusLines({ inXR, xrLine, summary, features, grid, proximity, probe, obstacles }) {
  const lines = [];
  if (inXR) {
    const granted = features && Object.keys(FEATURE_NAMES).filter((f) => features.includes(f));
    lines.push(
      granted ? `${xrLine} · ${granted.length ? granted.map((f) => FEATURE_NAMES[f]).join(', ') : 'no room features'}` : xrLine,
    );
  }
  const { planes, meshes, triangles } = summary;
  lines.push(
    planes || meshes
      ? `Room: ${planes} plane${planes === 1 ? '' : 's'}, ${meshes} mesh${meshes === 1 ? '' : 'es'}, ${triangles.toLocaleString()} triangles`
      : 'Room: nothing detected yet',
  );
  if (obstacles) {
    const near = inXR && proximity != null ? ` · nearest ${proximity.toFixed(2)} m` : '';
    lines.push(
      grid ? `Obstacles: ${grid.obstacles.toLocaleString()} cells of ${Math.round(grid.cell * 100)} cm${near}` : 'Obstacles: no map yet',
    );
  }
  lines.push(probe ? `Pointer: ${probe.label}, ${probe.distance.toFixed(2)} m away` : 'Pointer: point at a surface');
  return lines;
}

export default function App() {
  const [state, actions] = useRoomState();
  const roomVersion = useRoomVersion();
  const summary = useMemo(roomSummary, [roomVersion]);
  const hasRoom = summary.planes + summary.meshes > 0;
  const [grid, setGrid] = useState(null);
  const [proximity, setProximity] = useState(null);
  const [probe, setProbe] = useState(null);

  const support = useXRSupport();
  const session = useSyncExternalStore(store.subscribe, getSession);
  const sessionMode = useSyncExternalStore(store.subscribe, getSessionMode);
  const sessionActive = session != null;
  const xrSupported = Boolean(support.vr || support.ar);
  const phone = useMemo(isPhone, []);
  const headset = useMemo(isHeadsetBrowser, []);
  const passthroughAvailable = Boolean(support.ar) || phone;
  const views = useMemo(() => availableViews({ phone, headset, xrSupported }), [phone, headset, xrSupported]);
  const [screenView, setScreenView] = useState('normal'); // outside XR: 'normal' | 'sbs' | 'interlaced'
  const [phoneStereo, setPhoneStereo] = useState(true); // phone XR: two lens-corrected eyes
  const [handheld, setHandheld] = useState(false); // the motion-sensor view is showing (phones without AR)
  const inXR = sessionActive || handheld;
  // derived from the session, so the panel can never disagree with what is showing
  const view = inXR ? (phone ? (phoneStereo ? 'phoneViewer' : 'phoneAR') : 'xr') : screenView;
  const [error, setError] = useState(null);
  // Quest Browser only: opens Space Setup, to scan or redraw the room
  const roomCapture = typeof session?.initiateRoomCapture === 'function';

  const runAction = (id) => {
    if (id === 'export') {
      if (!getRoom().entries.size) return;
      exportRoomGLB().catch((e) => {
        console.error('[room-mesh] export failed', e);
        setError(`Couldn't export the room: ${describe(e)}`);
      });
    } else if (id === 'clear') clearRoom();
    else if (id === 'roomCapture' && roomCapture) {
      session.initiateRoomCapture().catch((e) => {
        console.warn('[room-mesh] room capture refused', e);
        setError(`Room Setup didn't open: ${describe(e)}`);
      });
    }
  };
  useKeyboard(actions, runAction);

  // into an XR view, straight from the tap
  const enterXR = async (stereo) => {
    setError(null);
    let label = 'AR';
    try {
      if (phone && support.ar) await enterWith(PHONE_AR_SESSION_INIT, () => store.enterAR());
      else if (phone) {
        enterCardboard({ landscape: stereo }).then((sensors) => {
          if (!sensors) console.warn('[room-mesh] motion sensor access denied; the view will not follow the phone');
        });
        setHandheld(true);
      } else if (support.ar) await enterWith(HEADSET_SESSION_INIT, () => store.enterAR());
      else {
        label = 'VR';
        await enterWith(HEADSET_SESSION_INIT, () => store.enterVR());
      }
    } catch (e) {
      console.error(`[room-mesh] could not start ${label}`, e);
      setError(`Couldn't start ${label}: ${describe(e)}`);
    }
  };
  // out of XR
  const exitXR = () => {
    if (handheld) {
      exitCardboard();
      setHandheld(false);
    }
    store.getState().session?.end();
  };

  // the motion-sensor view: stereo wants landscape, mono can be held either way
  useEffect(() => {
    if (!handheld) return;
    if (phoneStereo) screen.orientation?.lock?.('landscape').catch(() => {});
    else screen.orientation?.unlock?.();
  }, [handheld, phoneStereo]);
  // leaving fullscreen (back gesture, Esc) also leaves the motion-sensor view
  useEffect(() => {
    if (!handheld) return;
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) setHandheld(false);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, [handheld]);

  const onSelect = (id) => {
    if (id === MENU_TOGGLE) actions.toggleMenu();
    else if (id.startsWith(PAGE_PREFIX)) actions.setPage(id.slice(PAGE_PREFIX.length));
    else if (id.startsWith(PICK_PREFIX)) {
      const [dropdownId, index] = id.slice(PICK_PREFIX.length).split(':');
      const choice = dropdownChoices(env)[dropdownId]?.[Number(index)];
      if (choice === undefined) return;
      if (dropdownId === 'view') {
        actions.closeDropdown();
        selectView(choice);
      } else actions.pick(dropdownId, choice);
    } else if (DROPDOWNS.includes(id)) actions.toggleDropdown(id);
    else if (TOGGLES.includes(id)) actions.toggle(id);
    else if (ACTIONS.includes(id)) runAction(id);
  };
  const selectView = (next) => {
    const toXR = XR_VIEWS.includes(next);
    if (toXR) setPhoneStereo(next === 'phoneViewer');
    if (toXR && !inXR) {
      // if the session fails to start, the panel carries on from Normal
      setScreenView('normal');
      enterXR(next === 'phoneViewer');
    } else if (!toXR) {
      if (inXR) exitXR();
      setScreenView(next);
    }
  };

  // which XR path is running, shown on the panels
  const xrLine = handheld
    ? `XR: motion sensors only, ${phoneStereo ? 'stereo' : 'mono'}`
    : phone
      ? `XR: phone AR, ${phoneStereo ? 'stereo' : 'mono'}`
      : `XR: headset ${sessionMode === 'immersive-ar' ? 'AR' : 'VR'}`;
  const status = statusLines({
    inXR,
    xrLine,
    summary,
    features: getRoom().features,
    grid: state.obstacles ? grid : null,
    proximity,
    probe,
    obstacles: state.obstacles,
  });
  const env = { xrSupported, passthroughAvailable, checking: !support.checked, views, roomCapture, hasRoom };
  const labels = useMemo(() => possibleLabels({ xrSupported, passthroughAvailable, views }), [xrSupported, passthroughAvailable, views]);
  const menu = {
    title: menuTitle(state.page),
    rows: MENU_ROWS,
    labels,
    status,
    open: state.menuOpen,
    items: menuItems({ ...state, view }, env),
    onSelect,
  };
  const notes = [
    !inXR &&
      !hasRoom && {
        text: import.meta.env.DEV
          ? 'Choose Video → View Mode → XR: Headset to read the room. Here on localhost a Quest 3 emulator stands in, with a sample room.'
          : "Open this page in the Quest Browser and choose Video → View Mode → XR: Headset. The room comes from the headset's Space Setup, so run that first.",
      },
    error && { text: error, error: true },
  ].filter(Boolean);

  return (
    <>
      <Canvas flat dpr={[1, 2]} events={sideBySideEvents} camera={{ position: [2.5, 3.2, 4.5], fov: 50, near: 0.05, far: 200 }}>
        <XR store={store}>
          <Scene
            state={{ ...state, view, stereo: phoneStereo, handheld, passthrough: state.background === 'passthrough' }}
            menu={menu}
            phone={phone}
            onGrid={setGrid}
            onProximity={setProximity}
            onProbe={setProbe}
          />
        </XR>
      </Canvas>
      {handheld ? <CardboardOverlay split={phoneStereo} onHold={() => {}} onExit={exitXR} /> : <Hud menu={menu} notes={notes} />}
    </>
  );
}
