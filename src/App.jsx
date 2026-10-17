import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Canvas } from '@react-three/fiber';
import { XR, createXRStore, useXRSessionModeSupported } from '@react-three/xr';
import Scene from './Scene.jsx';
import { sideBySideEvents } from './SideBySide.jsx';
import Icon from './Icon.jsx';
import { MENU_TOGGLE } from './XRMenuPanel.jsx';
import { PHONE_AR_SESSION_INIT } from './PhoneStereo.jsx';
import { CardboardOverlay, canUseCardboard, enterCardboard, exitCardboard } from './Cardboard.jsx';
import { MODELS } from './depth/ml.js';
import { useDepthStatus } from './depth/store.js';
import { FILTERS, setFilter } from './filters.js';
import { useTestFeed } from './testFeed.js';
import {
  DEPTH_MODE_LABELS,
  DROPDOWNS,
  TOGGLES,
  XR_VIEWS,
  MENU_ROWS,
  availableViews,
  SECTION_PREFIX,
  SET_PREFIX,
  SLIDERS,
  PICK_PREFIX,
  cycle,
  menuItems,
  MENU_TITLE,
  dropdownChoices,
  possibleLabels,
  unavailableReason,
  splitLabel,
} from './menu.js';

// View Mode: Normal, 3D: SBS (half side-by-side, for 3D TVs and projectors)
// and 3D: Interlaced (alternate rows, for passive 3D monitors) are windowed.
// The XR views start a session, only from a tap, as browsers require, as in
// the 4D viewer:
//   XR: Headset (headsets) starts an AR session where supported (so every
//   background, passthrough included, can be switched live), otherwise VR.
//   XR: Phone AR / Phone Viewer start one AR session (tracked by ARCore) that
//   the app draws as one view, or two lens-corrected eyes for a phone viewer;
//   switching between the two is live. The session asks for the camera
//   image and ARCore's depth, which the depth passthrough turns into a
//   surface each eye sees from its own side. Phones without AR get a view
//   steered by the motion sensors instead, with the rear camera, flat, for
//   passthrough.

// kept as a reference: the store reads it whenever a session starts
const xrOptions = {
  // controllers and hands get ray / touch pointers by default, for the panel and the probe
  frameRate: 'high',
  // headset emulator on localhost during development only
  emulate: import.meta.env.DEV ? 'metaQuest3' : false,
  foveation: 0.5,
};
const store = createXRStore(xrOptions);

/** The headset session's options: the library's defaults, all optional so any headset starts. */
const HEADSET_SESSION_INIT = {
  requiredFeatures: ['local-floor'],
  optionalFeatures: ['hand-tracking', 'layers'],
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

function useAppState() {
  const [depthMode, setDepthMode] = useState('auto'); // see depth/DepthSource.jsx
  const [depthMesh, setDepthMesh] = useState(true); // the camera drawn at its depth, not flat
  const [smoothing, setSmoothing] = useState(0.5); // how much of the past goes into each depth frame, see depth/smooth.js
  const [convergence, setConvergence] = useState(0); // where the phone viewer's eyes meet, dioptres (0: ∞)
  const [strength, setStrength] = useState(1); // the phone viewer's eye separation, times true scale
  const [periphery, setPeriphery] = useState('outfill'); // the phone viewer beyond the camera: 'black' | 'outfill' | 'stretch'
  const [filter, setFilterName] = useState('none');
  const [background, setBackground] = useState('passthrough'); // 'solid' | 'skybox' | 'passthrough' | 'testFeed'
  const [menuOpen, setMenuOpen] = useState(true); // shared by the windowed and XR panels
  const [sections, setSections] = useState(['depth', 'video']); // the open sections, see menu.js
  const [dropdown, setDropdown] = useState(null); // the dropdown whose list is open

  const actions = useMemo(
    () => ({
      toggle: (id) => ({ depthMesh: setDepthMesh })[id]((v) => !v),
      nextFilter: (step = 1) => setFilterName((f) => cycle(FILTERS, f, step)),
      toggleMenu: () => setMenuOpen((v) => !v),
      toggleSection: (id) => {
        setSections((open) => (open.includes(id) ? open.filter((s) => s !== id) : [...open, id]));
        setDropdown(null);
      },
      toggleDropdown: (id) => setDropdown((d) => (d === id ? null : id)),
      closeDropdown: () => setDropdown(null),
      /** A slider's new value. */
      set: (id, value) => ({ strength: setStrength, convergence: setConvergence, smoothing: setSmoothing })[id](value),
      /** A choice from a dropdown's list (see dropdownChoices), which then closes. */
      pick: (id, choice) => {
        ({ depthMode: setDepthMode, periphery: setPeriphery, filter: setFilterName, background: setBackground })[id](choice);
        setDropdown(null);
      },
    }),
    [],
  );
  const state = { depthMode, smoothing, convergence, depthMesh, strength, periphery, filter, background, menuOpen, sections, dropdown };
  return [state, actions];
}

function useKeyboard(actions) {
  useEffect(() => {
    const keymap = {
      KeyF: actions.nextFilter,
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

/** What a button's right edge shows: a section's or a dropdown's chevron. */
function trailingIcon(item) {
  const open = item.section?.open ?? item.dropdown?.open;
  if (open !== undefined) return open ? 'dropdownOpen' : 'dropdown';
  return null;
}

/** A slider row: icon, name, the track, and the value at the right edge. */
function MenuSlider({ item, onSelect }) {
  const { name, value } = splitLabel(item.label);
  const { min, max, step } = item.slider;
  return (
    <label className={`menu-btn menu-slider${item.indent ? ' indent' : ''}`} title={item.title}>
      <Icon name={item.icon} />
      <span className="name">{name}:</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={item.slider.value}
        onChange={(e) => onSelect(`${SET_PREFIX}${item.id}:${e.target.value}`)}
      />
      <span className="value">{value}</span>
    </label>
  );
}

function MenuButtons({ items, labels, onSelect }) {
  return (
    <div className="menu-items">
      {items.map((item) => {
        const trailing = trailingIcon(item);
        if (item.slider) return <MenuSlider key={item.id} item={item} onSelect={onSelect} />;
        return (
          <Fragment key={item.id}>
            <button
              className={`menu-btn${item.indent ? ' indent' : ''}`}
              disabled={item.disabled}
              title={item.title}
              aria-expanded={item.section?.open ?? item.dropdown?.open}
              onClick={() => onSelect(item.id)}
            >
              <Icon name={item.icon} />
              <Label text={item.label} />
              {trailing && <Icon name={trailing} />}
            </button>
            {item.dropdown?.open && (
              <div className={`menu-options${item.indent ? ' indent' : ''}`} role="listbox">
                {item.dropdown.options.map((option) => (
                  <button
                    key={option.id}
                    className={`menu-option${option.selected ? ' selected' : ''}`}
                    role="option"
                    aria-selected={option.selected}
                    disabled={option.disabled}
                    title={option.title}
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
          <div key={label} className="menu-btn indent">
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
  const gear = (
    <button className="collapse" onClick={toggle} aria-label={menu.open ? 'Hide options' : 'Show options'} title="Options">
      <Icon name="gear" />
    </button>
  );
  if (!menu.open) {
    // collapsed: just the frame around the gear button
    return (
      <aside className="hud collapsed">
        <header>{gear}</header>
      </aside>
    );
  }
  return (
    <aside className="hud">
      <header>
        {gear}
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
const FEATURE_NAMES = { 'camera-access': 'camera', 'depth-sensing': 'depth', 'hit-test': 'hit test' };

const sourceName = (source) => (source === 'arcore+da2' ? 'ARCore + Depth Anything V2' : DEPTH_MODE_LABELS[source]);

/** The depth lines: the algorithm, how fast, how sure its scale is, and any model download. */
function depthLines(depth, active, mode) {
  const { ml } = depth;
  const lines = [];
  const model = ml.model && MODELS[ml.model];
  if (model && ml.state === 'loading')
    lines.push(`${model.name}: ${ml.progress ? `downloading ${ml.progress}% of ${model.mb} MB` : 'loading'}`);
  else if (model && ml.state === 'failed') lines.push(`${model.name} failed: ${ml.error}`);
  if (!active) return lines;
  if (!depth.source) {
    if ((mode === 'arcore' || mode === 'auto') && depth.arcore !== 'cpu')
      lines.push(depth.arcore === 'gpu' ? 'Depth: ARCore depth is GPU-only here' : 'Depth: this phone gives no ARCore depth');
    else lines.push(mode === 'off' ? 'Depth: off' : 'Depth: none yet');
    return lines;
  }
  const parts = [`${sourceName(depth.source)}${depth.test ? ' (test feed)' : ''}`];
  if (depth.rawSize && depth.source.startsWith('arcore')) parts[0] += ` ${depth.rawSize[0]}×${depth.rawSize[1]}`;
  const fromModel = MODELS[depth.source.replace('arcore+', '')];
  if (depth.source !== 'arcore') parts.push(`${fromModel && ml.ms != null ? ml.ms : depth.ms} ms`);
  if (ml.slow && depth.source === 'arcore') parts.push('model too slow');
  const fit = depth.fit;
  if (fit?.assumed) parts.push('scale assumed');
  else if (fit) parts.push(`scale ±${fit.error.toFixed(2)} m${depth.rawSize ? '' : ` from ${depth.anchors} hits`}`);
  if (depth.parallax)
    parts.push(
      depth.parallax.baseline < 2
        ? 'move the phone sideways'
        : `${depth.parallax.baseline} cm baseline, ${depth.parallax.tracked}% tracked`,
    );
  lines.push(`Depth: ${parts.join(' · ')}`);
  return lines;
}

/** The status lines both panels show above the buttons. */
function statusLines({ inXR, xrLine, features, depth, depthActive, depthMode }) {
  const lines = [];
  if (inXR) {
    const granted = features && Object.keys(FEATURE_NAMES).filter((f) => features.includes(f));
    lines.push(
      granted ? `${xrLine} · ${granted.length ? granted.map((f) => FEATURE_NAMES[f]).join(', ') : 'no camera or depth'}` : xrLine,
    );
  }
  lines.push(...depthLines(depth, depthActive, depthMode));
  return lines;
}

export default function App() {
  const [state, actions] = useAppState();
  useEffect(() => setFilter(state.filter), [state.filter]);
  useKeyboard(actions);
  const depth = useDepthStatus();

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
  // the desktop's stand-in for a phone camera, outside XR
  const testFeedAvailable = !phone && !headset;
  const testFeed = useTestFeed(testFeedAvailable && state.background === 'testFeed' && !inXR);

  // into an XR view, straight from the tap
  const enterXR = async (stereo) => {
    setError(null);
    let label = 'AR';
    try {
      if (phone && support.ar) await enterWith(PHONE_AR_SESSION_INIT, () => store.enterAR());
      else if (phone) {
        enterCardboard({ landscape: stereo }).then((sensors) => {
          if (!sensors) console.warn('[depth-xr] motion sensor access denied; the view will not follow the phone');
        });
        setHandheld(true);
      } else if (support.ar) await enterWith(HEADSET_SESSION_INIT, () => store.enterAR());
      else {
        label = 'VR';
        await enterWith(HEADSET_SESSION_INIT, () => store.enterVR());
      }
    } catch (e) {
      console.error(`[depth-xr] could not start ${label}`, e);
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
    else if (id.startsWith(SECTION_PREFIX)) actions.toggleSection(id.slice(SECTION_PREFIX.length));
    else if (id.startsWith(PICK_PREFIX)) {
      const [dropdownId, index] = id.slice(PICK_PREFIX.length).split(':');
      const choice = dropdownChoices()[dropdownId]?.[Number(index)];
      if (choice === undefined || unavailableReason(env, dropdownId, choice)) return;
      if (dropdownId === 'view') {
        actions.closeDropdown();
        selectView(choice);
      } else actions.pick(dropdownId, choice);
    } else if (id.startsWith(SET_PREFIX)) {
      const [sliderId, value] = id.slice(SET_PREFIX.length).split(':');
      if (SLIDERS.includes(sliderId) && Number.isFinite(Number(value))) actions.set(sliderId, Number(value));
    } else if (DROPDOWNS.includes(id)) actions.toggleDropdown(id);
    else if (TOGGLES.includes(id)) actions.toggle(id);
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
    features: session?.enabledFeatures,
    depth,
    depthActive: (sessionActive && sessionMode === 'immersive-ar') || Boolean(testFeed.video),
    depthMode: state.depthMode,
  });
  const env = { xrSupported, passthroughAvailable, testFeedAvailable, checking: !support.checked, phone, views };
  const labels = useMemo(
    () => possibleLabels({ xrSupported, passthroughAvailable, testFeedAvailable, views }),
    [xrSupported, passthroughAvailable, testFeedAvailable, views],
  );
  const menu = {
    title: MENU_TITLE,
    rows: MENU_ROWS,
    labels,
    status,
    open: state.menuOpen,
    items: menuItems({ ...state, view }, env),
    onSelect,
  };
  const notes = [
    !inXR &&
      !testFeed.video && {
        text: testFeedAvailable
          ? 'On an Android phone, open this page in Chrome and choose Video → View Mode → XR: Phone Viewer. Here, Video → Background → Test Feed runs depth on your webcam, or on a video file dropped on the page.'
          : 'Choose Video → View Mode → XR: Phone Viewer for stereo with depth, or XR: Phone AR for one view.',
      },
    testFeed.error && { text: testFeed.error, error: true },
    error && { text: error, error: true },
  ].filter(Boolean);

  return (
    <>
      <Canvas flat dpr={[1, 2]} events={sideBySideEvents} camera={{ position: [1.6, 2.2, 1.8], fov: 50, near: 0.05, far: 200 }}>
        <XR store={store}>
          <Scene
            state={{ ...state, view, stereo: phoneStereo, handheld, passthrough: state.background === 'passthrough' }}
            menu={menu}
            phone={phone}
            testFeed={testFeed.video}
          />
        </XR>
      </Canvas>
      {handheld ? <CardboardOverlay split={phoneStereo} onHold={() => {}} onExit={exitXR} /> : <Hud menu={menu} notes={notes} />}
    </>
  );
}
