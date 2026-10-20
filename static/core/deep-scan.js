// Opt-in model-based detection (OpenAI Privacy Filter) run in a worker.
// The model only proposes entities; the regular scanners turn them into findings.

const LABELS = {
  private_person: "PERSON",
  private_address: "STREET_ADDRESS",
  private_email: "EMAIL",
  private_phone: "PHONE",
  account_number: "ACCOUNT_NUMBER",
  private_date: "DATE",
  private_url: "URL",
  secret: "POTENTIAL_SECRET",
};
// The model sometimes runs an address on into the next words ("12 Elm Road, Leeds and cc"),
// so trailing filler words are trimmed off address spans.
const TRAILING_FILLER = /(?:[\s,;]+(?:and|or|then|cc|bcc|via|please|thanks))+[\s,;]*$/i;
// ponytail: fixed-size line chunks keep WebGPU memory bounded; a name split across a chunk edge can be missed
const CHUNK_CHARS = 4000;

let worker = null;
let nextId = 0;
const pending = new Map();
let lastText = null;
let lastEntities = [];

// ponytail: WebGPU only, since the q4f16 weights need it; add a WASM path with the q4 weights if non-WebGPU browsers matter
export const deepScanSupported = typeof navigator !== "undefined" && "gpu" in navigator;

function chunk(text) {
  const chunks = [];
  let current = "";
  for (const line of text.split(/(?<=\n)/)) {
    if (current && current.length + line.length > CHUNK_CHARS) {
      chunks.push(current);
      current = "";
    }
    current += line;
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

function ensureWorker(onProgress) {
  if (!worker) {
    worker = new Worker(new URL("./deep-scan-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") return worker.onProgress?.(data.progress);
      const request = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) request?.reject(new Error(data.error));
      else request?.resolve(data.spans);
    };
  }
  worker.onProgress = onProgress;
  return worker;
}

export function entitiesFromSpans(spans) {
  const seen = new Set();
  return spans
    .map((span) => {
      const label = LABELS[span.entity_group];
      const text = span.word.trim();
      return { label, text: label === "STREET_ADDRESS" ? text.replace(TRAILING_FILLER, "") : text, score: span.score };
    })
    .filter((entity) => entity.label && entity.text.length > 1 && !seen.has(`${entity.label}:${entity.text}`) && seen.add(`${entity.label}:${entity.text}`));
}

export async function deepScanEntities(text, onProgress) {
  if (text === lastText) return lastEntities;
  const id = nextId++;
  const { promise, resolve, reject } = Promise.withResolvers();
  pending.set(id, { resolve, reject });
  ensureWorker(onProgress).postMessage({ id, chunks: chunk(text) });
  lastEntities = entitiesFromSpans(await promise);
  lastText = text;
  return lastEntities;
}

export function shutdownDeepScan() {
  worker?.terminate();
  worker = null;
  for (const request of pending.values()) request.reject(new Error("Deep scan stopped."));
  pending.clear();
  lastText = null;
  lastEntities = [];
}
