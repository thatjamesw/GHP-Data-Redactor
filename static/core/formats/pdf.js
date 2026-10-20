import { applyTextReplacements } from "../replacements.js";
import { annotateFindings, loadVendorScript, summarise } from "../utils.js";
import { scanTextValue } from "../detectors.js";

const PDF_SCRIPT_URL = new URL("../../vendor/pdfjs/pdf.min.mjs", import.meta.url);
const PDF_WORKER_URL = new URL("../../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url);
const PDF_STANDARD_FONT_URL = new URL("../../vendor/pdfjs/standard_fonts/", import.meta.url);
const PDFLIB_SCRIPT_PATH = "./static/vendor/pdflib/pdf-lib.min.js";

let pdfPromise = null;
let pdfLibPromise = null;

async function ensurePdfJs() {
  if (pdfPromise) return pdfPromise;
  pdfPromise = (async () => {
    const browser = typeof document !== "undefined";
    const imported = browser
      ? await import(PDF_SCRIPT_URL.href)
      : await import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdfjs = imported.default || imported;
    if (browser && pdfjs.GlobalWorkerOptions) pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL.href;
    return pdfjs;
  })();
  return pdfPromise;
}

async function ensurePdfLib() {
  if (pdfLibPromise) return pdfLibPromise;
  pdfLibPromise = typeof document === "undefined"
    ? import("pdf-lib")
    : loadVendorScript(PDFLIB_SCRIPT_PATH, "PDFLib", (lib) => lib?.PDFDocument);
  return pdfLibPromise;
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

function buildCandidates(group) {
  const candidates = [];
  for (let start = 0; start < group.length; start += 1) {
    let text = "";
    const positions = [];
    for (let end = start; end < Math.min(group.length, start + 12); end += 1) {
      const prefix = text ? " " : "";
      const from = text.length + prefix.length;
      text += `${prefix}${group[end].text}`;
      positions.push({ from, to: from + group[end].text.length, item: group[end] });
      candidates.push({ text, positions: [...positions], items: group.slice(start, end + 1) });
    }
  }
  return candidates;
}

function groupPageItems(items = []) {
  const rows = [];
  for (const item of items) {
    const text = String(item.text || "").trim();
    if (!text) continue;
    let row = rows.find((entry) => Math.abs(entry.y - item.bbox.y0) < 3);
    if (!row) {
      row = { y: item.bbox.y0, items: [] };
      rows.push(row);
    }
    row.items.push(item);
  }
  return rows
    .sort((left, right) => left.y - right.y)
    .map((row) => row.items.sort((left, right) => left.bbox.x0 - right.bbox.x0));
}

function extractPdfItems(textContent, viewport) {
  return (textContent.items || []).map((item) => {
    const text = String(item.str || "");
    const width = Math.max(1, Number(item.width || 0));
    const height = Math.max(8, Number(item.height || Math.abs(item.transform?.[0] || 0) || 12));
    const x = Number(item.transform?.[4] || 0);
    const y = Number(item.transform?.[5] || 0);
    const y0 = viewport.height - y - height;
    return {
      text,
      bbox: {
        x0: x,
        y0,
        x1: x + width,
        y1: y0 + height,
      },
    };
  }).filter((item) => item.text.trim());
}

function pagePreviewText(lines) {
  return lines.map((line) => line.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

function lineText(line) {
  return line.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
}

function lineBox(line) {
  return unionBox(line.map((item) => item.bbox));
}

function syntheticFinding(label, confidence, original, box, reasoning, previewPath, category, pageNumber) {
  return {
    label,
    category,
    confidence,
    start: 0,
    end: original.length,
    original,
    reasoning,
    context: {
      kind: "pdf",
      pageNumber,
      previewPath,
      bbox: box,
    },
  };
}

function buildPdfFormHeuristics(page, options = {}) {
  const findings = [];
  const lines = page.lines.map((group, index) => ({
    index,
    text: lineText(group),
    lower: lineText(group).toLowerCase(),
    box: lineBox(group),
  })).filter((line) => line.text);

  for (const line of lines) {
    if (/\b(name|customer name|account holder|applicant name)\s*:/.test(line.lower)) {
      findings.push(
        syntheticFinding(
          "PERSON_FIELD",
          0.96,
          line.text,
          normaliseBox(line.box, page.width, page.height, 6),
          ["pdf_form_field_name"],
          `Page ${page.pageNumber}`,
          "identity",
          page.pageNumber
        )
      );
    }
    if (options.imageMode === "document_safe" && /\b(address|phone|mobile|account|a\/c|branch|cif|iban|swift|routing|sort code|beneficiary|holder|customer|date|dated)\b/.test(line.lower)) {
      findings.push(
        syntheticFinding(
          "DOCUMENT_FIELD_ROW",
          0.95,
          line.text,
          normaliseBox(line.box, page.width, page.height, 6),
          ["pdf_document_field_row"],
          `Page ${page.pageNumber}`,
          "pii",
          page.pageNumber
        )
      );
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/\b(yours faithfully|yours sincerely|signature|signed by|authorized signatory|account holder signature)\b/.test(line.lower)) continue;

    const nextLines = [];
    for (let cursor = index + 1; cursor < Math.min(lines.length, index + 4); cursor += 1) {
      const candidate = lines[cursor];
      if (/\b(dated|date)\s*:/.test(candidate.lower)) break;
      nextLines.push(candidate);
    }

    const regionLines = [line, ...nextLines];
    const union = unionBox(regionLines.map((entry) => entry.box));
    const signatureBox = normaliseBox({
      x0: Math.max(0, Math.min(line.box.x0, page.width * 0.12)),
      y0: line.box.y0,
      x1: Math.min(page.width, Math.max(union.x1, page.width * 0.78)),
      y1: Math.min(page.height, union.y1 + page.height * 0.03),
    }, page.width, page.height, 6);

    findings.push(
      syntheticFinding(
        "SIGNATURE_BLOCK",
        0.98,
        regionLines.map((entry) => entry.text).join(" "),
        signatureBox,
        ["pdf_signature_block"],
        `Page ${page.pageNumber}`,
        "identity",
        page.pageNumber
      )
    );

    const personLikeLine = nextLines.find((entry) => /^[A-Z][A-Za-z.' -]{3,}$/.test(entry.text));
    if (personLikeLine) {
      findings.push(
        syntheticFinding(
          "PERSON",
          0.93,
          personLikeLine.text,
          normaliseBox(personLikeLine.box, page.width, page.height, 4),
          ["pdf_signoff_name"],
          `Page ${page.pageNumber}`,
          "identity",
          page.pageNumber
        )
      );
    }
  }

  const deduped = new Map();
  for (const finding of findings) {
    const box = finding.context?.bbox;
    const key = `${finding.label}:${finding.context?.pageNumber}:${box?.x0}:${box?.y0}:${box?.x1}:${box?.y1}`;
    if (!deduped.has(key) || deduped.get(key).confidence < finding.confidence) deduped.set(key, finding);
  }
  return [...deduped.values()];
}

function pageFindings(page, options = {}) {
  const findings = [];
  page.lines.forEach((group) => {
    const lineText = group.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
    if (!lineText) return;
    for (const candidate of buildCandidates(group)) {
      const matches = scanTextValue(candidate.text, options, {
        kind: "pdf",
        pageNumber: page.pageNumber,
        previewPath: `Page ${page.pageNumber}`,
      });
      for (const match of matches) {
        const overlapping = candidate.positions.filter((position) => !(match.end <= position.from || match.start >= position.to));
        if (!overlapping.length) continue;
        const box = unionBox(overlapping.map((position) => position.item.bbox));
        findings.push({
          label: match.label,
          category: match.category,
          confidence: match.confidence,
          start: match.start,
          end: match.end,
          original: candidate.text.slice(match.start, match.end),
          reasoning: [...match.reasoning, "pdf_bbox_map"],
          context: {
            ...match.context,
            kind: "pdf",
            pageNumber: page.pageNumber,
            previewPath: `Page ${page.pageNumber}`,
            bbox: normaliseBox(box, page.width, page.height, 2),
          },
        });
      }
    }
  });

  const deduped = new Map();
  for (const finding of findings) {
    const box = finding.context?.bbox;
    const key = `${finding.label}:${finding.original}:${finding.context?.pageNumber}:${box?.x0}:${box?.y0}:${box?.x1}:${box?.y1}`;
    if (!deduped.has(key) || deduped.get(key).confidence < finding.confidence) deduped.set(key, finding);
  }
  return [...deduped.values(), ...buildPdfFormHeuristics(page, options)];
}

function joinPages(pages, key = "text") {
  return pages.map((page) => `[Page ${page.pageNumber}]\n${page[key]}`.trim()).join("\n\n");
}

async function loadPdfDocument(sourceBytes) {
  const pdfjs = await ensurePdfJs();
  const bytes = new Uint8Array(sourceBytes.slice(0));
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableWorker: typeof document === "undefined",
    standardFontDataUrl: typeof document === "undefined"
      ? new URL("../../vendor/pdfjs/standard_fonts/", import.meta.url).pathname
      : PDF_STANDARD_FONT_URL.href,
  });
  return loadingTask.promise;
}

async function renderRedactedPages(scanResult, selected) {
  const pdf = await loadPdfDocument(scanResult.document.sourceBytes);
  const pages = [];
  for (const pageMeta of scanResult.document.pages) {
    const page = await pdf.getPage(pageMeta.pageNumber);
    const scale = 1.6;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d");
    await page.render({ canvasContext: context, viewport }).promise;

    const findings = scanResult.findings.filter((finding) => selected.has(finding.id) && finding.context?.pageNumber === pageMeta.pageNumber);
    context.fillStyle = "#000";
    for (const finding of findings) {
      const box = finding.context?.bbox;
      if (!box) continue;
      context.fillRect(
        box.x0 * scale,
        box.y0 * scale,
        Math.max(8, (box.x1 - box.x0) * scale),
        Math.max(8, (box.y1 - box.y0) * scale)
      );
    }

    pages.push({
      pageNumber: pageMeta.pageNumber,
      width: pageMeta.width,
      height: pageMeta.height,
      previewWidth: canvas.width,
      previewHeight: canvas.height,
      dataUrl: canvas.toDataURL("image/png"),
    });
  }
  return pages;
}

function dataUrlToUint8Array(dataUrl) {
  const base64 = dataUrl.split(",")[1] || "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function buildPdfBinary(pages) {
  const PDFLib = await ensurePdfLib();
  const pdfDoc = await PDFLib.PDFDocument.create();
  for (const page of pages) {
    const image = await pdfDoc.embedPng(dataUrlToUint8Array(page.dataUrl));
    const pdfPage = pdfDoc.addPage([page.width, page.height]);
    pdfPage.drawImage(image, { x: 0, y: 0, width: page.width, height: page.height });
  }
  return pdfDoc.save();
}

export async function preparePdfDocument(fileState) {
  const pdf = await loadPdfDocument(fileState.arrayBuffer);
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const items = extractPdfItems(textContent, viewport);
    const lines = groupPageItems(items);
    pages.push({
      pageNumber,
      width: viewport.width,
      height: viewport.height,
      items,
      lines,
      text: pagePreviewText(lines),
    });
  }
  return {
    kind: "pdf",
    name: fileState.name || "document.pdf",
    sourceBytes: fileState.arrayBuffer.slice(0),
    pages,
    extractedText: joinPages(pages),
    formatInfo: {
      label: "PDF (visual redaction)",
      guarantee: "Pages are rendered locally and sensitive regions are covered with black bars. Export creates a flattened redacted PDF.",
    },
  };
}

export function scanPdfDocument(document, options = {}) {
  const findings = document.pages.flatMap((page) => pageFindings(page, options));
  const annotated = annotateFindings(findings);
  return {
    document,
    findings: annotated,
    summary: summarise(annotated),
    preview: document.extractedText,
    formatInfo: document.formatInfo,
  };
}

export async function redactPdfDocument(scanResult, selectedIds, mode) {
  const selected = new Set(selectedIds);
  const pages = scanResult.document.pages.map((page) => {
    const matches = scanResult.findings.filter((finding) => selected.has(finding.id) && finding.context?.pageNumber === page.pageNumber);
    return {
      ...page,
      redactedText: applyTextReplacements(page.text, matches, selected, mode),
    };
  });

  if (typeof document === "undefined") {
    return {
      text: joinPages(pages, "redactedText"),
      fileName: scanResult.document.name.replace(/\.pdf$/i, "") + "-redacted.txt",
      formatInfo: scanResult.formatInfo,
    };
  }

  const visualPages = await renderRedactedPages(scanResult, selected);
  const binaryData = await buildPdfBinary(visualPages);
  return {
    text: "Redacted PDF ready. Review the page previews or export the flattened PDF.",
    fileName: scanResult.document.name.replace(/\.pdf$/i, "") + "-redacted.pdf",
    formatInfo: scanResult.formatInfo,
    copyable: false,
    isPdf: true,
    pdfPages: visualPages,
    binaryData,
    blobType: "application/pdf",
  };
}
