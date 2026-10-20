import { env, pipeline } from "../vendor/transformers/transformers.min.js";

// Model weights come from Hugging Face, pinned to one revision. The runtime is served locally.
const MODEL = "openai/privacy-filter";
const REVISION = "7ffa9a043d54d1be65afb281eddf0ffbe629385b";

env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = new URL("../vendor/transformers/", import.meta.url).href;

let classifierPromise = null;

function loadClassifier() {
  classifierPromise ??= pipeline("token-classification", MODEL, {
    revision: REVISION,
    device: "webgpu",
    dtype: "q4f16",
    progress_callback: (progress) => self.postMessage({ type: "progress", progress }),
  }).catch((error) => {
    classifierPromise = null;
    throw error;
  });
  return classifierPromise;
}

self.onmessage = async ({ data: { id, chunks } }) => {
  try {
    const classifier = await loadClassifier();
    const spans = [];
    for (const chunk of chunks) spans.push(...(await classifier(chunk, { aggregation_strategy: "simple" })));
    self.postMessage({ type: "result", id, spans: spans.map(({ entity_group, word, score }) => ({ entity_group, word, score })) });
  } catch (error) {
    self.postMessage({ type: "result", id, error: String(error?.message || error) });
  }
};
