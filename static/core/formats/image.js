import { scanTextValue } from "../detectors.js";
import { loadVendorScript, summarise } from "../utils.js";

const TESSERACT_SCRIPT_PATH = "./static/vendor/tesseract/tesseract.min.js";
const TESSERACT_WORKER_PATH = "./static/vendor/tesseract/worker.min.js";
const TESSERACT_CORE_PATH = "./static/vendor/tesseract/core";
const TESSERACT_LANG_PATH = "./static/vendor/tesseract/lang";

let workerPromise = null;
let activeWorker = null;

function ensureTesseract() {
  return loadVendorScript(TESSERACT_SCRIPT_PATH, "Tesseract", (lib) => typeof lib?.recognize === "function");
}

async function ensureWorker() {
  if (workerPromise) return workerPromise;

  workerPromise = (async () => {
    const Tesseract = await ensureTesseract();
    if (typeof Tesseract.createWorker !== "function") {
      throw new Error("Local OCR bundle loaded, but createWorker is unavailable.");
    }
    const worker = await Tesseract.createWorker("eng", 1, {
      workerPath: TESSERACT_WORKER_PATH,
      corePath: TESSERACT_CORE_PATH,
      langPath: TESSERACT_LANG_PATH,
      workerBlobURL: false,
      gzip: true,
      cacheMethod: "none",
      logger: () => {},
    });
    await worker.setParameters({
      preserve_interword_spaces: "1",
      user_defined_dpi: "300",
    });
    activeWorker = worker;
    return worker;
  })().catch((error) => {
    workerPromise = null;
    activeWorker = null;
    throw error;
  });

  return workerPromise;
}

export async function shutdownImageWorker() {
  if (!activeWorker) return;
  await activeWorker.terminate();
  activeWorker = null;
  workerPromise = null;
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load the image for OCR."));
    image.src = dataUrl;
  });
}

async function buildOcrImageDataUrl(dataUrl) {
  const image = await loadImage(dataUrl);
  const scale = Math.max(1.6, Math.min(2.2, 1800 / Math.max(image.width, image.height)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const frame = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = frame.data;
  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
    const contrasted = luminance < 128 ? Math.max(0, luminance - 18) : Math.min(255, luminance + 24);
    pixels[index] = contrasted;
    pixels[index + 1] = contrasted;
    pixels[index + 2] = contrasted;
  }
  context.putImageData(frame, 0, 0);

  return {
    dataUrl: canvas.toDataURL("image/png"),
    scaleX: canvas.width / image.width,
    scaleY: canvas.height / image.height,
  };
}

function unionBox(boxes) {
  return boxes.reduce(
    (acc, box) => ({
      x0: Math.min(acc.x0, box.x0),
      y0: Math.min(acc.y0, box.y0),
      x1: Math.max(acc.x1, box.x1),
      y1: Math.max(acc.y1, box.y1),
    }),
    { x0: Number.POSITIVE_INFINITY, y0: Number.POSITIVE_INFINITY, x1: 0, y1: 0 }
  );
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normaliseBox(box, width, height, padding = 0) {
  return {
    x0: clamp(box.x0 - padding, 0, width),
    y0: clamp(box.y0 - padding, 0, height),
    x1: clamp(box.x1 + padding, 0, width),
    y1: clamp(box.y1 + padding, 0, height),
  };
}

function padBoxByRatio(box, width, height, ratio = 0.08) {
  const padX = Math.max(8, (box.x1 - box.x0) * ratio);
  const padY = Math.max(8, (box.y1 - box.y0) * ratio);
  return {
    x0: clamp(box.x0 - padX, 0, width),
    y0: clamp(box.y0 - padY, 0, height),
    x1: clamp(box.x1 + padX, 0, width),
    y1: clamp(box.y1 + padY, 0, height),
  };
}

function lineGroups(words) {
  const map = new Map();
  words.forEach((word, index) => {
    const key = `${word.block_num ?? 0}:${word.par_num ?? 0}:${word.line_num ?? 0}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ ...word, index });
  });
  return [...map.values()].map((group) => group.sort((left, right) => (left.word_num ?? left.index) - (right.word_num ?? right.index)));
}

function lineEntries(groups, scaleX, scaleY) {
  return groups.map((group, index) => {
    const box = unionBox(group.map((word) => ({
      x0: word.bbox.x0 / scaleX,
      y0: word.bbox.y0 / scaleY,
      x1: word.bbox.x1 / scaleX,
      y1: word.bbox.y1 / scaleY,
    })));
    return {
      index,
      text: group.map((word) => word.text).join(" ").trim(),
      box,
      words: group.map((word) => ({
        ...word,
        bbox: {
          x0: word.bbox.x0 / scaleX,
          y0: word.bbox.y0 / scaleY,
          x1: word.bbox.x1 / scaleX,
          y1: word.bbox.y1 / scaleY,
        },
      })),
    };
  });
}

function parseTsvWords(tsv = "") {
  const rows = String(tsv).split(/\r?\n/).filter(Boolean);
  if (!rows.length) return [];
  const words = [];
  for (const row of rows) {
    const columns = row.split("\t");
    if (columns.length < 12) continue;
    const level = Number(columns[0]);
    if (level !== 5) continue;
    const [,, block_num, par_num, line_num, word_num, left, top, width, height, conf, text] = columns;
    const value = String(text || "").trim();
    if (!value) continue;
    words.push({
      text: value,
      confidence: Number(conf),
      block_num: Number(block_num),
      par_num: Number(par_num),
      line_num: Number(line_num),
      word_num: Number(word_num),
      bbox: {
        x0: Number(left),
        y0: Number(top),
        x1: Number(left) + Number(width),
        y1: Number(top) + Number(height),
      },
    });
  }
  return words;
}

function buildCandidates(group) {
  const candidates = [];
  for (let start = 0; start < group.length; start += 1) {
    let text = "";
    const positions = [];
    for (let end = start; end < Math.min(group.length, start + 10); end += 1) {
      const prefix = text ? " " : "";
      const from = text.length + prefix.length;
      text += `${prefix}${group[end].text}`;
      positions.push({ from, to: from + group[end].text.length, word: group[end] });
      candidates.push({ text, positions: [...positions], words: group.slice(start, end + 1) });
    }
  }
  return candidates;
}

async function detectFaceFindings(document, options = {}) {
  if (!options.detectFaces || typeof globalThis.FaceDetector !== "function") return [];
  try {
    const image = await loadImage(document.dataUrl);
    const detector = new globalThis.FaceDetector({ fastMode: true, maxDetectedFaces: 6 });
    const faces = await detector.detect(image);
    return faces.map((face, index) => {
      const rect = face.boundingBox;
      const padded = padBoxByRatio(
        { x0: rect.x, y0: rect.y, x1: rect.x + rect.width, y1: rect.y + rect.height },
        document.width,
        document.height,
        0.18
      );
      return {
        id: `f-face-${index + 1}`,
        label: "FACE",
        category: "identity",
        confidence: 0.98,
        start: 0,
        end: 0,
        original: "Detected face",
        reasoning: ["face_detector"],
        context: {
          kind: "image",
          previewPath: `image.face_${index + 1}`,
          bbox: padded,
        },
        replacement: "[REDACTED]",
      };
    });
  } catch (error) {
    return [];
  }
}

function fallbackPortraitFinding(document, lines, options = {}) {
  if (!options.detectFaces || !options.aggressiveImageDocs) return [];
  const textHeavyRightSide = lines.some((line) => line.box.x0 >= document.width * 0.34 && line.box.y0 >= document.height * 0.18 && line.box.y1 <= document.height * 0.78);
  if (!textHeavyRightSide) return [];
  const portraitBox = {
    x0: document.width * 0.06,
    y0: document.height * 0.24,
    x1: document.width * 0.31,
    y1: document.height * 0.64,
  };
  return [{
    id: "f-face-fallback-1",
    label: "FACE",
    category: "identity",
    confidence: 0.86,
    start: 0,
    end: 0,
    original: "Likely portrait region",
    reasoning: ["document_portrait_fallback"],
    context: {
      kind: "image",
      previewPath: "image.face_fallback",
      bbox: portraitBox,
    },
    replacement: "[REDACTED]",
  }];
}

function looksLikePassportDocument(lines, document) {
  const text = lines.map((line) => line.text).join("\n").toUpperCase();
  const fileHint = String(document.name || "").toUpperCase();
  return /PASSPORT|PASSEPORT|REISEPASS|TRAVEL DOCUMENT|P<|MRZ/.test(text) || /PASSPORT|ID|TRAVEL/.test(fileHint);
}

function lineLooksLikeMrz(line) {
  const text = line.text.toUpperCase();
  const compact = text.replace(/\s/g, "");
  const specialCount = (compact.match(/[<|]/g) || []).length;
  const alnumCount = (compact.match(/[A-Z0-9]/g) || []).length;
  return compact.startsWith("P<") || (specialCount >= 2 && alnumCount >= 12) || (alnumCount >= 22 && /[A-Z]/.test(compact) && /\d/.test(compact));
}

function syntheticFinding(label, confidence, original, box, reasoning, previewPath, category) {
  return {
    label,
    category,
    confidence,
    start: 0,
    end: original.length,
    original,
    reasoning,
    context: {
      kind: "image",
      previewPath,
      bbox: box,
    },
  };
}

function buildDocumentHeuristicFindings(lines, document, options = {}) {
  if (!lines.length) return [];
  const findings = [];
  const passportLike = looksLikePassportDocument(lines, document);
  const imageHeight = document.height || 1;
  const imageWidth = document.width || 1;

  for (const line of lines) {
    const upper = line.text.toUpperCase();
    const isBottomBand = line.box.y0 >= imageHeight * 0.64;
    const hasPassportNumber = /(?:^|[^A-Z0-9])[A-Z][0-9]{5,8}(?:[^A-Z0-9]|$)/.test(upper);
    if ((passportLike && isBottomBand && lineLooksLikeMrz(line)) || (passportLike && hasPassportNumber && line.box.x0 >= imageWidth * 0.45)) {
      findings.push(
        syntheticFinding(
          "PASSPORT_ZONE",
          0.97,
          line.text || "Passport zone",
          normaliseBox(line.box, imageWidth, imageHeight, 12),
          ["passport_document_zone"],
          `ocr.line_${line.index + 1}`,
          "pii"
        )
      );
    }
  }

  if (options.aggressiveImageDocs) {
    for (const line of lines) {
      const contentChars = (line.text.match(/[A-Za-z0-9]/g) || []).length;
      if (contentChars < 2) continue;
      if (line.box.y0 < imageHeight * 0.15 || line.box.y1 > imageHeight * 0.96) continue;
      findings.push(
        syntheticFinding(
          "DOCUMENT_TEXT",
          0.94,
          line.text,
          normaliseBox(line.box, imageWidth, imageHeight, 8),
          ["aggressive_document_text"],
          `ocr.line_${line.index + 1}`,
          "identity"
        )
      );
    }
  }

  return findings;
}

function imageFindingsFromCandidates(candidates, options, lineIndex) {
  const findings = [];
  for (const candidate of candidates) {
    const matches = scanTextValue(candidate.text, options, { kind: "image", previewPath: `ocr.line_${lineIndex + 1}` });
    for (const match of matches) {
      const overlapping = candidate.positions.filter((position) => !(match.end <= position.from || match.start >= position.to));
      if (!overlapping.length) continue;
      const box = unionBox(overlapping.map((position) => position.word.bbox));
      findings.push({
        label: match.label,
        category: match.category,
        confidence: match.confidence,
        start: match.start,
        end: match.end,
        original: candidate.text.slice(match.start, match.end),
        reasoning: [...match.reasoning, "ocr_bbox_map"],
        context: {
          ...match.context,
          previewPath: `ocr.line_${lineIndex + 1}`,
          bbox: box,
        },
      });
    }
  }
  const deduped = new Map();
  for (const finding of findings) {
    const box = finding.context.bbox;
    const key = `${finding.label}:${finding.original}:${box.x0}:${box.y0}:${box.x1}:${box.y1}`;
    if (!deduped.has(key) || deduped.get(key).confidence < finding.confidence) deduped.set(key, finding);
  }
  return [...deduped.values()];
}

export function prepareImageDocument(fileState) {
  return {
    kind: "image",
    name: fileState.name || "pasted-image.png",
    mimeType: fileState.mimeType || "image/png",
    dataUrl: fileState.dataUrl,
    width: fileState.width,
    height: fileState.height,
    formatInfo: {
      label: "Image",
      guarantee: "OCR runs locally in the browser. Export uses black-box redaction over detected regions rather than text replacement.",
    },
  };
}

export async function scanImageDocument(document, options = {}) {
  const worker = await ensureWorker();
  const prepared = await buildOcrImageDataUrl(document.dataUrl);
  const result = await worker.recognize(prepared.dataUrl, {}, { tsv: true });
  const words = parseTsvWords(result.data.tsv).filter((word) => {
    const text = String(word.text || "").trim();
    const confidence = Number(word.confidence ?? word.conf ?? 0);
    return text && confidence >= 22 && word.bbox;
  });
  const lines = lineGroups(words);
  const lineData = lineEntries(lines, prepared.scaleX, prepared.scaleY);
  const findings = [];
  lines.forEach((group, lineIndex) => {
    findings.push(
      ...imageFindingsFromCandidates(
        buildCandidates(group).map((candidate) => ({
          ...candidate,
          positions: candidate.positions.map((position) => ({
            ...position,
            word: {
              ...position.word,
              bbox: {
                x0: position.word.bbox.x0 / prepared.scaleX,
                y0: position.word.bbox.y0 / prepared.scaleY,
                x1: position.word.bbox.x1 / prepared.scaleX,
                y1: position.word.bbox.y1 / prepared.scaleY,
              },
            },
          })),
        })),
        options,
        lineIndex
      )
    );
  });
  findings.push(...buildDocumentHeuristicFindings(lineData, document, options));
  const faceFindings = await detectFaceFindings(document, options);
  findings.push(...faceFindings);
  if (!faceFindings.length) findings.push(...fallbackPortraitFinding(document, lineData, options));

  const annotated = findings.map((finding, index) => {
    const label = finding.label || "";
    const paddedBox = finding.context?.bbox
      ? (
        label === "FACE"
          ? padBoxByRatio(finding.context.bbox, document.width, document.height, 0.12)
          : ["PASSPORT", "PASSPORT_ZONE", "DOCUMENT_TEXT"].includes(label)
            ? normaliseBox(finding.context.bbox, document.width, document.height, 10)
            : normaliseBox(finding.context.bbox, document.width, document.height, 4)
      )
      : undefined;
    return {
      ...finding,
      id: `f-${String(index + 1).padStart(4, "0")}`,
      replacement: "[REDACTED]",
      context: {
        ...finding.context,
        bbox: paddedBox,
      },
    };
  });
  const preview = lineData.map((line) => line.text).join("\n");
  return { document, findings: annotated, summary: summarise(annotated), preview, formatInfo: document.formatInfo };
}

export async function redactImageDocument(scanResult, selectedIds) {
  const image = await loadImage(scanResult.document.dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);

  const selected = new Set(selectedIds);
  for (const finding of scanResult.findings) {
    if (!selected.has(finding.id)) continue;
    const box = finding.context?.bbox;
    if (!box) continue;
    context.fillStyle = "#000";
    context.fillRect(box.x0, box.y0, Math.max(8, box.x1 - box.x0), Math.max(8, box.y1 - box.y0));
  }

  return {
    text: "Redacted image ready. Use the preview or export the file.",
    imageDataUrl: canvas.toDataURL("image/png"),
    fileName: scanResult.document.name.replace(/\.[^.]+$/, "") + "-redacted.png",
    formatInfo: scanResult.formatInfo,
    isImage: true,
    copyable: false,
  };
}
