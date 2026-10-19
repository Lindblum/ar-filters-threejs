// Main-thread side of the depth models (ml.worker.js): starts the worker on
// first use, switches models on request, and keeps at most one frame in
// flight, so inference never queues up behind the camera (as the 2D-3D
// converter's bridge does).

const LOAD_TIMEOUT_MS = 300_000; // up to 105 MB over a phone's connection

/** The models, by id: their names and download sizes, for the panels. */
export const MODELS = {
  da2: { name: 'Depth Anything V2', mb: 50 },
  da3: { name: 'Depth Anything V3', mb: 105 },
  midas: { name: 'MiDaS', mb: 66 },
};

/**
 * The image size a model takes for a view of `aspect` (width / height):
 * MiDaS a fixed 256 x 256 square (the picture is squeezed to fit), the
 * Depth Anything models any size in 14 px patches, up to 392 on the long side.
 */
export function modelInputSize(model, aspect) {
  if (model === 'midas') return { width: 256, height: 256 };
  const LONG = 392;
  const round14 = (n) => Math.max(14, Math.round(n / 14) * 14);
  return aspect >= 1 ? { width: LONG, height: round14(LONG / aspect) } : { width: round14(LONG * aspect), height: LONG };
}

class DepthModel {
  model = null; // the model loaded, or being loaded
  state = 'idle'; // 'idle' | 'loading' | 'ready' | 'failed'
  provider = '';
  error = '';
  progress = 0; // 0..1 while downloading
  busy = false;
  worker = null;
  timer = null;
  nextId = 1;
  pending = new Map();
  listeners = new Set();

  /** Called with no arguments whenever model, state, provider, error or progress change. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    this.listeners.forEach((l) => l());
  }

  isReady(model) {
    return this.state === 'ready' && this.model === model;
  }

  /** Loads `model` (switching from another if need be). */
  load(model) {
    if (this.model === model && this.state !== 'idle') return;
    if (!this.worker) this.start();
    this.model = model;
    this.state = 'loading';
    this.provider = '';
    this.error = '';
    this.progress = 0;
    this.abandon();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(model, `timed out loading ${MODELS[model].name}`), LOAD_TIMEOUT_MS);
    this.worker.postMessage({ type: 'init', model });
    this.notify();
  }

  start() {
    this.worker = new Worker(new URL('./ml.worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress' && msg.model === this.model) {
        this.progress = msg.total ? msg.loaded / msg.total : 0;
        this.notify();
      } else if (msg.type === 'ready' && msg.model === this.model) {
        clearTimeout(this.timer);
        this.state = 'ready';
        this.provider = msg.provider;
        this.notify();
      } else if (msg.type === 'error') {
        this.fail(msg.model, msg.message);
      } else if (msg.type === 'depth' || msg.type === 'frame-error') {
        const resolve = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        this.busy = false;
        if (msg.type === 'frame-error') console.warn('[ar-filters] depth frame failed:', msg.message);
        resolve?.(msg.type === 'depth' ? msg : null);
      }
    };
    this.worker.onerror = (e) => this.fail(this.model, e.message || 'the depth worker failed to start');
  }

  /** Frames in flight for a previous model resolve empty. */
  abandon() {
    this.busy = false;
    this.pending.forEach((resolve) => resolve(null));
    this.pending.clear();
  }

  fail(model, message) {
    if (model !== this.model) return;
    clearTimeout(this.timer);
    this.state = 'failed';
    this.error = message;
    this.abandon();
    console.warn('[ar-filters] depth model unavailable:', message);
    this.notify();
  }

  /**
   * Runs the model on a top-down RGBA image. Resolves with { data, width,
   * height, min, max, ms } (relative inverse depth), or null if busy, not
   * ready, or it failed. The image's buffer is handed to the worker.
   */
  run(rgba, width, height) {
    if (this.state !== 'ready' || this.busy) return Promise.resolve(null);
    this.busy = true;
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage({ type: 'frame', id, rgba, width, height }, [rgba.buffer]);
    });
  }
}

export const depthModel = new DepthModel();
