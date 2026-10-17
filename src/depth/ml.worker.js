// Depth Anything V2 Small in a worker, so inference never holds up a frame.
// Ported from the 2D-3D video converter's depth host (youtube-3d-convert-addon
// src/depth/host.ts). The model comes from Hugging Face on first use and is
// kept in the Cache API after that; onnxruntime's .wasm is served with the
// app (Vite emits it).
//
// Messages in:  { type: 'init' } | { type: 'frame', id, rgba, width, height }
// Messages out: { type: 'progress', loaded, total } | { type: 'ready', provider }
//               | { type: 'error', message } | { type: 'frame-error', id, message }
//               | { type: 'depth', id, data, width, height, min, max, ms }
// `data` is relative inverse depth: larger is nearer, in no particular unit.
import * as ort from 'onnxruntime-web/webgpu';

const MODEL_BASE = 'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx';
const CACHE = 'depth-xr-models';
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

ort.env.wasm.numThreads = 1; // the page isn't cross-origin isolated, so no SharedArrayBuffer
ort.env.wasm.proxy = false;

let session = null;
let loading = null;

const send = (msg, transfer = []) => self.postMessage(msg, transfer);

/** The model file's bytes, from the cache or the network (reporting progress), then cached. */
async function fetchModel(url) {
  const cache = await caches.open(CACHE).catch(() => null);
  const hit = await cache?.match(url);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const res = await fetch(url);
  if (!res.ok) throw new Error(`model download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  let lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (loaded - lastReport > 1 << 20) {
      lastReport = loaded;
      send({ type: 'progress', loaded, total });
    }
  }
  const bytes = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  await cache?.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })).catch(() => {});
  return bytes;
}

/**
 * WebGPU with the fp16 model where the GPU has shader-f16, else fp32; with
 * no WebGPU at all, the 8-bit model on the CPU (slow, but it runs).
 */
async function load() {
  const adapter = await self.navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
  const attempts = adapter
    ? [
        ...(adapter.features.has('shader-f16') ? [{ file: 'model_fp16.onnx', ep: 'webgpu', label: 'WebGPU fp16' }] : []),
        { file: 'model.onnx', ep: 'webgpu', label: 'WebGPU fp32' },
      ]
    : [];
  attempts.push({ file: 'model_quantized.onnx', ep: 'wasm', label: 'CPU int8 (slow)' });
  let lastError;
  for (const { file, ep, label } of attempts) {
    try {
      const bytes = await fetchModel(`${MODEL_BASE}/${file}`);
      session = await ort.InferenceSession.create(bytes, { executionProviders: [ep], graphOptimizationLevel: 'all' });
      const vendor = adapter?.info?.vendor;
      return `Depth Anything V2 · ${label}${ep === 'webgpu' && vendor ? ` · ${vendor}` : ''}`;
    } catch (e) {
      console.warn(`[depth-xr] ${label} failed:`, e);
      lastError = e;
    }
  }
  throw lastError;
}

function toTensor(rgba, w, h) {
  const n = w * h;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    out[i] = (rgba[i * 4] / 255 - MEAN[0]) / STD[0];
    out[n + i] = (rgba[i * 4 + 1] / 255 - MEAN[1]) / STD[1];
    out[2 * n + i] = (rgba[i * 4 + 2] / 255 - MEAN[2]) / STD[2];
  }
  return new ort.Tensor('float32', out, [1, 3, h, w]);
}

/**
 * 2nd and 98th percentiles of the depth output (from a subsample). Unlike min/max, a few
 * extreme pixels can't make the whole scene's depth pump.
 */
function percentileRange(data) {
  const stride = Math.max(1, Math.floor(data.length / 8192));
  const sample = new Float32Array(Math.ceil(data.length / stride));
  for (let i = 0, j = 0; i < data.length; i += stride) sample[j++] = data[i];
  sample.sort();
  const at = (q) => sample[Math.min(sample.length - 1, Math.floor(q * sample.length))];
  return [at(0.02), at(0.98)];
}

async function runFrame({ id, rgba, width, height }) {
  if (!session) return send({ type: 'frame-error', id, message: 'model not loaded' });
  try {
    const t0 = performance.now();
    const input = toTensor(rgba, width, height);
    const result = await session.run({ [session.inputNames[0]]: input }, [session.outputNames[0]]);
    const out = result[session.outputNames[0]];
    const data = new Float32Array(out.data); // a copy we own, to transfer
    const [h, w] = out.dims.slice(-2);
    input.dispose();
    out.dispose();
    const [min, max] = percentileRange(data);
    send({ type: 'depth', id, data, width: w, height: h, min, max, ms: performance.now() - t0 }, [data.buffer]);
  } catch (e) {
    send({ type: 'frame-error', id, message: e instanceof Error ? e.message : String(e) });
  }
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    loading ??= load()
      .then((provider) => send({ type: 'ready', provider }))
      .catch((err) => send({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
  } else if (msg.type === 'frame') runFrame(msg);
};
