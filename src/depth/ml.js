// Main-thread side of the depth model (ml.worker.js): starts the worker on
// first use and keeps at most one frame in flight, so inference never queues
// up behind the camera (as the 2D-3D converter's bridge does).

const LOAD_TIMEOUT_MS = 180_000; // a 50 MB model over a phone's connection

class DepthModel {
  state = 'idle'; // 'idle' | 'loading' | 'ready' | 'failed'
  provider = '';
  error = '';
  progress = 0; // 0..1 while downloading
  busy = false;
  worker = null;
  nextId = 1;
  pending = new Map();
  listeners = new Set();

  /** Called with no arguments whenever state, provider, error or progress change. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    this.listeners.forEach((l) => l());
  }

  /** Starts loading the model, once. */
  load() {
    if (this.worker) return;
    this.state = 'loading';
    this.worker = new Worker(new URL('./ml.worker.js', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => this.fail('timed out loading the depth model'), LOAD_TIMEOUT_MS);
    this.worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        this.progress = msg.total ? msg.loaded / msg.total : 0;
        this.notify();
      } else if (msg.type === 'ready') {
        clearTimeout(timer);
        this.state = 'ready';
        this.provider = msg.provider;
        this.notify();
      } else if (msg.type === 'error') {
        clearTimeout(timer);
        this.fail(msg.message);
      } else if (msg.type === 'depth' || msg.type === 'frame-error') {
        const resolve = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        this.busy = false;
        if (msg.type === 'frame-error') console.warn('[depth-xr] depth frame failed:', msg.message);
        resolve?.(msg.type === 'depth' ? msg : null);
      }
    };
    this.worker.onerror = (e) => {
      clearTimeout(timer);
      this.fail(e.message || 'the depth worker failed to start');
    };
    this.worker.postMessage({ type: 'init' });
    this.notify();
  }

  fail(message) {
    this.state = 'failed';
    this.error = message;
    this.busy = false;
    this.pending.forEach((resolve) => resolve(null));
    this.pending.clear();
    console.warn('[depth-xr] depth model unavailable:', message);
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
