// The depth models in a worker, so inference never holds up a frame. Ported
// from the 2D-3D video converter's depth host (youtube-3d-convert-addon
// src/depth/host.ts). Models come from Hugging Face on first use and are
// kept in the Cache API after that; onnxruntime's .wasm is served with the
// app (Vite emits it).
//
// Messages in:  { type: 'init', model } | { type: 'frame', id, rgba, width, height }
// Messages out: { type: 'progress', model, loaded, total } | { type: 'ready', model, provider }
//               | { type: 'error', model, message } | { type: 'frame-error', id, message }
//               | { type: 'depth', id, data, width, height, min, max, ms }
// `data` is relative inverse depth: larger is nearer, in no particular unit.
import * as ort from 'onnxruntime-web/webgpu';

const CACHE = 'depth-xr-models';
const DA2 = 'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx';
const DA3 = 'https://huggingface.co/onnx-community/depth-anything-v3-small/resolve/main/onnx';
const MIDAS = 'https://huggingface.co/InDepthDesigns/midas_v21_small_256/resolve/main';
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/**
 * How each model is loaded, fed and read. `files(gpu)`: the attempts in
 * order, each { url, ep, label, externalData? }. `multiView`: the input has
 * a views dimension, [batch, views, 3, H, W]. `outputIsDistance`: far is
 * large, not near.
 */
const MODELS = {
  da2: {
    name: 'Depth Anything V2',
    files: (gpu) => [
      ...(gpu?.f16 ? [{ url: `${DA2}/model_fp16.onnx`, ep: 'webgpu', label: 'WebGPU fp16' }] : []),
      ...(gpu ? [{ url: `${DA2}/model.onnx`, ep: 'webgpu', label: 'WebGPU fp32' }] : []),
      { url: `${DA2}/model_quantized.onnx`, ep: 'wasm', label: 'CPU int8 (slow)' },
    ],
  },
  da3: {
    name: 'Depth Anything V3',
    files: (gpu) =>
      [
        ...(gpu ? [{ ep: 'webgpu', label: 'WebGPU fp32' }] : []),
        { ep: 'wasm', label: 'CPU fp32 (slow)' },
      ].map((a) => ({ ...a, url: `${DA3}/model.onnx`, externalData: `${DA3}/model.onnx_data` })),
    multiView: true,
    outputIsDistance: true,
  },
  midas: {
    name: 'MiDaS v2.1',
    files: (gpu) =>
      [...(gpu ? [{ ep: 'webgpu', label: 'WebGPU fp32' }] : []), { ep: 'wasm', label: 'CPU fp32 (slow)' }].map((a) => ({
        ...a,
        url: `${MIDAS}/midas_v21_small_256.onnx`,
      })),
  },
};

ort.env.wasm.numThreads = 1; // the page isn't cross-origin isolated, so no SharedArrayBuffer
ort.env.wasm.proxy = false;

let session = null;
let loadedModel = null;
let provider = '';
let running = null; // the inference in progress; a model switch waits for it before releasing
let loadSeq = 0; // bumped per init, so a slow load that was superseded doesn't report

const send = (msg, transfer = []) => self.postMessage(msg, transfer);

/** A file's bytes, from the cache or the network (reporting progress), then cached. */
async function fetchFile(url, model, report) {
  const cache = await caches.open(CACHE).catch(() => null);
  const hit = await cache?.match(url);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
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
    if (report && loaded - lastReport > 1 << 20) {
      lastReport = loaded;
      send({ type: 'progress', model, loaded, total });
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

async function init(model) {
  if (session && loadedModel === model) return send({ type: 'ready', model, provider });
  const seq = ++loadSeq;
  const old = session;
  session = null; // frames are refused from here on
  loadedModel = null;
  await running?.catch(() => {});
  await old?.release().catch(() => {});
  try {
    const adapter = await self.navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
    const gpu = adapter && { f16: adapter.features.has('shader-f16') };
    const spec = MODELS[model];
    let lastError;
    for (const { url, ep, label, externalData } of spec.files(gpu)) {
      try {
        // the big file reports progress: the weights where they're separate, else the model
        const bytes = await fetchFile(url, model, !externalData);
        const data = externalData ? await fetchFile(externalData, model, true) : null;
        const s = await ort.InferenceSession.create(bytes, {
          executionProviders: [ep],
          graphOptimizationLevel: 'all',
          ...(data ? { externalData: [{ path: 'model.onnx_data', data }] } : {}),
        });
        if (seq !== loadSeq) return void s.release(); // another model was asked for meanwhile
        const vendor = adapter?.info?.vendor;
        provider = `${spec.name} · ${label}${ep === 'webgpu' && vendor ? ` · ${vendor}` : ''}`;
        session = s;
        loadedModel = model;
        return send({ type: 'ready', model, provider });
      } catch (e) {
        console.warn(`[depth-xr] ${spec.name} ${label} failed:`, e);
        lastError = e;
      }
    }
    throw lastError;
  } catch (e) {
    if (seq === loadSeq) send({ type: 'error', model, message: e instanceof Error ? e.message : String(e) });
  }
}

function toTensor(rgba, w, h) {
  const n = w * h;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    out[i] = (rgba[i * 4] / 255 - MEAN[0]) / STD[0];
    out[n + i] = (rgba[i * 4 + 1] / 255 - MEAN[1]) / STD[1];
    out[2 * n + i] = (rgba[i * 4 + 2] / 255 - MEAN[2]) / STD[2];
  }
  return new ort.Tensor('float32', out, MODELS[loadedModel].multiView ? [1, 1, 3, h, w] : [1, 3, h, w]);
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
  const s = session;
  if (!s || !loadedModel) return send({ type: 'frame-error', id, message: 'model not loaded' });
  try {
    const t0 = performance.now();
    const spec = MODELS[loadedModel];
    const input = toTensor(rgba, width, height);
    // only the depth output (Depth Anything V3 also has confidence and camera outputs)
    const run = s.run({ [s.inputNames[0]]: input }, [s.outputNames[0]]);
    running = run;
    const result = await run.finally(() => {
      if (running === run) running = null;
    });
    const out = result[s.outputNames[0]];
    const data = new Float32Array(out.data); // a copy we own, to transfer
    const [h, w] = out.dims.slice(-2);
    input.dispose();
    out.dispose();
    // everything downstream expects near = large (inverse distance, like disparity)
    if (spec.outputIsDistance) for (let i = 0; i < data.length; i++) data[i] = 1 / Math.max(data[i], 1e-6);
    const [min, max] = percentileRange(data);
    send({ type: 'depth', id, data, width: w, height: h, min, max, ms: performance.now() - t0 }, [data.buffer]);
  } catch (e) {
    send({ type: 'frame-error', id, message: e instanceof Error ? e.message : String(e) });
  }
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') init(msg.model);
  else if (msg.type === 'frame') runFrame(msg);
};
