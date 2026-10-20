import { benchmarkCorpus } from "./core/benchmark-data.js";
import { deepScanEntities, deepScanSupported, shutdownDeepScan } from "./core/deep-scan.js";
import { shutdownImageWorker } from "./core/formats/image.js";
import { findingsForDisplay, prepareDocument, redactDocument, scanDocument, scanTextValue } from "./redactor-core.js";

const fileInput = document.querySelector("#file-input");
const textInput = document.querySelector("#text-input");
const refreshScanButton = document.querySelector("#refresh-scan-button");
const presetSelect = document.querySelector("#preset-select");
const modeSelect = document.querySelector("#mode-select");
const confidenceSelect = document.querySelector("#confidence-select");
const imageModeSelect = document.querySelector("#image-mode-select");
const filterSearch = document.querySelector("#filter-search");
const strictEmail = document.querySelector("#strict-email");
const detectNames = document.querySelector("#detect-names");
const deepScan = document.querySelector("#deep-scan");
const deepScanDownloads = new Map();
const detectFaces = document.querySelector("#detect-faces");
const categoryToggles = [...document.querySelectorAll(".category-toggle")];
const findingsEl = document.querySelector("#findings");
const reviewEmpty = document.querySelector("#review-empty");
const outputEl = document.querySelector("#output");
const reviewPanel = document.querySelector(".review-panel");
const reviewExpandButton = document.querySelector("#review-expand-button");
const outputPanel = document.querySelector(".output-panel");
const outputExpandButton = document.querySelector("#output-expand-button");
const focusShell = document.querySelector("#focus-shell");
const focusHost = document.querySelector("#focus-host");
const inputStatus = document.querySelector("#input-status");
const outputStatus = document.querySelector("#output-status");
const outputRisk = document.querySelector("#output-risk");
const benchmarkStatus = document.querySelector("#benchmark-status");
const benchmarkResults = document.querySelector("#benchmark-results");
const benchmarkBreakdown = document.querySelector("#benchmark-breakdown");
const benchmarkTotal = document.querySelector("#benchmark-total");
const benchmarkHit = document.querySelector("#benchmark-hit");
const benchmarkRate = document.querySelector("#benchmark-rate");
const fileSummary = document.querySelector("#file-summary");
const formatNote = document.querySelector("#format-note");
const outputNote = document.querySelector("#output-note");
const copyButton = document.querySelector("#copy-button");
const downloadButton = document.querySelector("#download-button");
const stickySafeCopyButton = document.querySelector("#sticky-safe-copy");
const stickyRefreshScanButton = document.querySelector("#sticky-refresh-scan-button");
const stickyCopyButton = document.querySelector("#sticky-copy-button");
const stickyDownloadButton = document.querySelector("#sticky-download-button");
const stickySelection = document.querySelector("#sticky-selection");
const stickySummary = document.querySelector("#sticky-summary");
const metricTotal = document.querySelector("#metric-total");
const metricHigh = document.querySelector("#metric-high");
const metricMedium = document.querySelector("#metric-medium");
const metricAuto = document.querySelector("#metric-auto");
const metricCurrent = document.querySelector("#metric-current");
const metricLeft = document.querySelector("#metric-left");
const selectionNote = document.querySelector("#selection-note");
const imageTools = document.querySelector("#image-tools");
const manualBoxButton = document.querySelector("#manual-box-button");
const deleteManualBoxButton = document.querySelector("#delete-manual-box-button");
const clearManualBoxesButton = document.querySelector("#clear-manual-boxes-button");
const clearButton = document.querySelector("#clear-button");

let fileState = null;
let scanState = null;
let outputState = null;
let selectionState = new Set();
let recommendedSelectionState = new Set();
let manualDrawMode = false;
let manualBoxDraft = null;
let manualBoxCounter = 0;
let selectedManualFindingId = null;
let manualDragState = null;
let activeFocusKind = "";
let activeFocusPanel = null;
let focusPlaceholder = null;
let inputDirtySinceScan = false;
let configDirtySinceScan = false;

const presets = {
  llm_safe: {
    strictEmail: true,
    detectNames: true,
    detectFaces: true,
    imageMode: "standard",
    confidence: "high",
    categories: { pii: true, identity: true, financial: true, network: true, secrets: true },
  },
  paranoid: {
    strictEmail: true,
    detectNames: true,
    detectFaces: true,
    imageMode: "document_safe",
    confidence: "medium",
    categories: { pii: true, identity: true, financial: true, network: true, secrets: true },
  },
  balanced: {
    strictEmail: true,
    detectNames: true,
    detectFaces: true,
    imageMode: "standard",
    confidence: "medium",
    categories: { pii: true, identity: true, financial: true, network: true, secrets: true },
  },
  secrets_only: {
    strictEmail: true,
    detectNames: false,
    detectFaces: false,
    imageMode: "standard",
    confidence: "high",
    categories: { pii: false, identity: false, financial: false, network: true, secrets: true },
  },
  structured_pii: {
    strictEmail: true,
    detectNames: true,
    detectFaces: true,
    imageMode: "document_safe",
    confidence: "medium",
    categories: { pii: true, identity: true, financial: true, network: false, secrets: false },
  },
};

function setStatus(element, message, type = "") {
  element.textContent = message;
  element.className = `status ${type}`.trim();
}

function escapeHtml(text) {
  return String(text ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderSummary(summary = { total: 0, high: 0, medium: 0 }) {
  metricTotal.textContent = String(summary.total || 0);
  metricHigh.textContent = String(summary.high || 0);
  metricMedium.textContent = String(summary.medium || 0);
}

function reportDeepScanProgress(progress) {
  if (progress.status !== "progress" || !progress.total) return;
  deepScanDownloads.set(progress.file, progress);
  const downloads = [...deepScanDownloads.values()];
  const megabytes = (bytes) => Math.round(bytes / 1e6);
  const loaded = megabytes(downloads.reduce((sum, item) => sum + item.loaded, 0));
  const total = megabytes(downloads.reduce((sum, item) => sum + item.total, 0));
  setStatus(inputStatus, `Deep scan: downloading the model once (${loaded} of ${total} MB). Your text stays in this browser.`, "warn");
}

function setsEqual(left, right) {
  return left.size === right.size && left.isSubsetOf(right);
}

function renderSelectionTrust() {
  const autoCount = recommendedSelectionState.size;
  const currentCount = selectionState.size;
  const total = scanState?.findings?.length || 0;
  const leftCount = Math.max(0, total - currentCount);
  metricAuto.textContent = String(autoCount);
  metricCurrent.textContent = String(currentCount);
  metricLeft.textContent = String(leftCount);

  if (!scanState) {
    selectionNote.textContent = "High-confidence findings will be auto-selected after a scan.";
    outputRisk.textContent = "Run a scan to see whether anything is still outside the current output.";
    outputRisk.className = "risk-banner";
    return;
  }
  const thresholdLabel = confidenceSelect.value === "medium" ? "high and medium confidence" : "high confidence";
  if (setsEqual(selectionState, recommendedSelectionState)) {
    selectionNote.textContent = `Auto-selection is using ${thresholdLabel}. ${leftCount} finding${leftCount === 1 ? "" : "s"} remain outside the current output.`;
  } else {
    const added = [...selectionState].filter((id) => !recommendedSelectionState.has(id)).length;
    const removed = [...recommendedSelectionState].filter((id) => !selectionState.has(id)).length;
    selectionNote.textContent = `You adjusted the default selection: ${added} added, ${removed} removed. Current output reflects ${currentCount} selected finding${currentCount === 1 ? "" : "s"}.`;
  }
  if (inputDirtySinceScan || configDirtySinceScan) {
    const staleReason = inputDirtySinceScan ? "content" : "scan configuration";
    outputRisk.textContent = `The ${staleReason} changed after this output was generated. Refresh the scan before copying or exporting.`;
    outputRisk.className = "risk-banner warn";
  } else if (leftCount > 0) {
    outputRisk.textContent = `${leftCount} finding${leftCount === 1 ? "" : "s"} remain outside the current output. Review before copying or exporting if you want the safest possible result.`;
    outputRisk.className = "risk-banner warn";
  } else {
    outputRisk.textContent = "All current findings are included in the output. Copy or export is in a good state.";
    outputRisk.className = "risk-banner safe";
  }
}

function refreshActions() {
  const hasOutput = Boolean((outputState?.text || "").trim());
  const scanStale = inputDirtySinceScan || configDirtySinceScan;
  const outputStale = Boolean(scanStale && outputState);
  const downloadable = !outputStale && Boolean((outputState?.text || "").trim() || outputState?.imageDataUrl);
  const copyable = !outputStale && hasOutput && outputState?.copyable !== false && !outputState?.isImage;
  copyButton.disabled = !copyable;
  downloadButton.disabled = !downloadable;
  stickyCopyButton.disabled = !copyable;
  stickyDownloadButton.disabled = !downloadable;
  stickySelection.textContent = `${selectionState.size} selected`;
  stickySummary.textContent = outputStale
    ? (inputDirtySinceScan ? "Content changed. Refresh scan before copying or exporting." : "Scan settings changed. Refresh scan before copying or exporting.")
    : downloadable
    ? "Current output is ready to copy or export."
    : (scanState ? "Adjust findings and output will update automatically." : "Run a scan to generate safe output.");
  if (refreshScanButton) {
    refreshScanButton.disabled = !scanState || !scanStale;
  }
  if (stickyRefreshScanButton) {
    stickyRefreshScanButton.disabled = !scanState || !scanStale;
  }
}

function syncFocusButtons() {
  if (reviewExpandButton) {
    const reviewExpanded = activeFocusKind === "review";
    reviewExpandButton.textContent = reviewExpanded ? "Collapse review" : "Expand review";
    reviewExpandButton.setAttribute("aria-pressed", reviewExpanded ? "true" : "false");
  }
  if (outputExpandButton) {
    const outputExpanded = activeFocusKind === "output";
    outputExpandButton.textContent = outputExpanded ? "Collapse output" : "Expand output";
    outputExpandButton.setAttribute("aria-pressed", outputExpanded ? "true" : "false");
  }
}

function closeFocusPanel() {
  if (!activeFocusPanel || !focusPlaceholder) return;
  activeFocusPanel.classList.remove("focused-panel");
  focusPlaceholder.parentNode?.insertBefore(activeFocusPanel, focusPlaceholder);
  focusPlaceholder.remove();
  focusPlaceholder = null;
  activeFocusPanel = null;
  activeFocusKind = "";
  focusShell?.classList.add("hidden");
  focusShell?.setAttribute("aria-hidden", "true");
  document.body.classList.remove("focus-open");
  syncFocusButtons();
  void document.body.offsetHeight;
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
}

function openFocusPanel(kind) {
  const panel = kind === "review" ? reviewPanel : outputPanel;
  if (!panel || !focusHost || !focusShell) return;
  if (activeFocusKind === kind) {
    closeFocusPanel();
    return;
  }
  closeFocusPanel();
  focusPlaceholder = document.createElement("div");
  focusPlaceholder.className = "focus-placeholder";
  panel.parentNode?.insertBefore(focusPlaceholder, panel);
  focusHost.appendChild(panel);
  panel.classList.add("focused-panel");
  activeFocusPanel = panel;
  activeFocusKind = kind;
  focusShell.classList.remove("hidden");
  focusShell.setAttribute("aria-hidden", "false");
  document.body.classList.add("focus-open");
  syncFocusButtons();
  panel.scrollIntoView({ block: "start", behavior: "instant" });
}

function manualFindings() {
  return (scanState?.findings || []).filter((finding) => finding.reasoning?.includes("manual_redaction_box"));
}

function syncImageToolState() {
  const visualDocument = Boolean(
    (scanState?.document?.kind === "image" && outputState?.isImage)
    || (scanState?.document?.kind === "pdf" && outputState?.isPdf)
  );
  imageTools.classList.toggle("hidden", !visualDocument);
  manualBoxButton.disabled = !visualDocument;
  deleteManualBoxButton.disabled = !visualDocument || !selectedManualFindingId;
  clearManualBoxesButton.disabled = !visualDocument || manualFindings().length === 0;
  manualBoxButton.textContent = manualDrawMode ? "Drawing boxes…" : "Draw blackout boxes";
}

function renderFormatNote(formatInfo, target) {
  target.textContent = formatInfo ? `${formatInfo.label}: ${formatInfo.guarantee}` : "";
}

function lightweightFormatInfo(fileMeta, fileName = "") {
  const lower = (fileName || "").toLowerCase();
  if (fileMeta?.kind === "image") {
    return {
      label: "Image",
      guarantee: "OCR and redaction happen locally in the browser. Export uses black-box region redaction.",
    };
  }
  if (fileMeta?.kind === "pdf" || lower.endsWith(".pdf")) {
    return {
      label: "PDF (visual redaction)",
      guarantee: "Pages are rendered locally and sensitive regions are covered with black bars. Export creates a flattened redacted PDF.",
    };
  }
  if (fileMeta?.kind === "docx" || lower.endsWith(".docx")) {
    return {
      label: "DOCX (text extraction)",
      guarantee: "Document text is extracted locally and exported as cleaned text. Original DOCX layout is not rewritten yet.",
    };
  }
  if (fileMeta?.kind === "xlsx" || lower.endsWith(".xlsx")) {
    return {
      label: "Excel workbook (.xlsx)",
      guarantee: "Workbook structure, sheet names, rows, columns, and untouched cell formatting stay in place. Redacted cells are rewritten safely as plain values.",
    };
  }
  return null;
}

function mimeTypeForFile(name = "") {
  const lower = name.toLowerCase();
  if (lower.endsWith(".json")) return "application/json;charset=utf-8";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "application/yaml;charset=utf-8";
  if (lower.endsWith(".csv")) return "text/csv;charset=utf-8";
  if (lower.endsWith(".tsv")) return "text/tab-separated-values;charset=utf-8";
  if (lower.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return "text/plain;charset=utf-8";
}

function wipeArrayBuffer(buffer) {
  if (!(buffer instanceof ArrayBuffer)) return;
  try {
    new Uint8Array(buffer).fill(0);
  } catch {}
}

function wipeTypedArray(view) {
  if (!ArrayBuffer.isView(view)) return;
  try {
    if (typeof view.fill === "function") view.fill(0);
    else new Uint8Array(view.buffer, view.byteOffset, view.byteLength).fill(0);
  } catch {}
}

function wipeBinaryValue(value) {
  if (!value) return;
  if (value instanceof ArrayBuffer) {
    wipeArrayBuffer(value);
    return;
  }
  if (ArrayBuffer.isView(value)) wipeTypedArray(value);
}

function wipeFileState(state) {
  if (!state) return;
  wipeArrayBuffer(state.arrayBuffer);
  if ("dataUrl" in state) state.dataUrl = "";
  if ("name" in state) state.name = "";
}

function wipeScanState(state) {
  if (!state) return;
  for (const finding of state.findings || []) {
    finding.original = "";
    finding.replacement = "";
    if (finding.context?.bbox) {
      finding.context.bbox.x0 = 0;
      finding.context.bbox.y0 = 0;
      finding.context.bbox.x1 = 0;
      finding.context.bbox.y1 = 0;
    }
  }
  const documentModel = state.document;
  if (!documentModel) return;
  if ("content" in documentModel) documentModel.content = "";
  if ("extractedText" in documentModel) documentModel.extractedText = "";
  if ("dataUrl" in documentModel) documentModel.dataUrl = "";
  if ("name" in documentModel) documentModel.name = "";
  if (Array.isArray(documentModel.pages)) {
    for (const page of documentModel.pages) {
      if ("text" in page) page.text = "";
      if ("dataUrl" in page) page.dataUrl = "";
      if (Array.isArray(page.lines)) {
        for (const line of page.lines) line.text = "";
      }
    }
  }
}

function wipeOutputState(state) {
  if (!state) return;
  if ("text" in state) state.text = "";
  if ("imageDataUrl" in state) state.imageDataUrl = "";
  if ("fileName" in state) state.fileName = "";
  wipeBinaryValue(state.binaryData);
}

async function secureSessionWipe() {
  clearButton.disabled = true;
  setStatus(inputStatus, "Secure wipe in progress. Clearing previews, buffers, and local worker state.", "warn");
  await shutdownImageWorker();
  shutdownDeepScan();
  wipeOutputState(outputState);
  wipeScanState(scanState);
  wipeFileState(fileState);

  fileInput.value = "";
  textInput.value = "";
  filterSearch.value = "";
  fileState = null;
  scanState = null;
  outputState = null;
  selectionState = new Set();
  recommendedSelectionState = new Set();
  inputDirtySinceScan = false;
  configDirtySinceScan = false;
  manualDrawMode = false;
  manualBoxDraft = null;
  selectedManualFindingId = null;
  manualDragState = null;
  findingsEl.innerHTML = "";
  outputEl.innerHTML = "";
  fileSummary.textContent = "No file selected.";
  formatNote.textContent = "Format guarantees will appear here after the app recognises your input.";
  outputNote.textContent = "Output formatting notes will appear here once content has been processed.";
  benchmarkResults.textContent = "Benchmark results will appear here.";
  benchmarkResults.classList.add("empty");
  benchmarkBreakdown.textContent = "Category breakdown will appear here after running the benchmark.";
  benchmarkTotal.textContent = "0";
  benchmarkHit.textContent = "0";
  benchmarkRate.textContent = "0%";
  renderSummary();
  renderSelectionTrust();
  reviewEmpty.classList.remove("hidden");
  refreshActions();
  syncImageToolState();
  setStatus(inputStatus, "Secure wipe complete. The current session, previews, worker state, and in-memory buffers were cleared as aggressively as the browser allows.", "success");
  setStatus(outputStatus, "", "");
  setStatus(benchmarkStatus, "", "");
  clearButton.disabled = false;
}

function autoSelectThreshold() {
  return confidenceSelect.value === "medium" ? 0.55 : 0.8;
}

function currentEnabledCategories() {
  return Object.fromEntries(categoryToggles.map((toggle) => [toggle.dataset.category, toggle.checked]));
}

function applyPreset(name) {
  const preset = presets[name];
  if (!preset) return;
  strictEmail.checked = preset.strictEmail;
  detectNames.checked = preset.detectNames;
  detectFaces.checked = preset.detectFaces;
  imageModeSelect.value = preset.imageMode;
  confidenceSelect.value = preset.confidence;
  categoryToggles.forEach((toggle) => {
    toggle.checked = preset.categories[toggle.dataset.category] !== false;
  });
}

function currentOptions() {
  return {
    strictEmail: strictEmail.checked,
    detectNames: detectNames.checked,
    detectFaces: detectFaces.checked,
    aggressiveImageDocs: imageModeSelect.value === "document_safe",
    imageMode: imageModeSelect.value,
    enabledCategories: currentEnabledCategories(),
  };
}

function broadDiagnosticOptions() {
  return {
    strictEmail: true,
    detectNames: true,
    detectFaces: false,
    aggressiveImageDocs: false,
    imageMode: "standard",
    enabledCategories: {
      pii: true,
      identity: true,
      financial: true,
      network: true,
      secrets: true,
    },
  };
}

async function currentDocument() {
  const sourceText = fileState?.kind === "text" ? fileState.text : textInput.value;
  const fileName = fileState ? fileState.name : undefined;
  return prepareDocument({ textInput: sourceText, fileName, fileMeta: fileState });
}

async function readInputFile(file) {
  const lowerName = (file.name || "").toLowerCase();
  if ((file.type || "").startsWith("image/")) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Could not read the image file."));
      reader.readAsDataURL(file);
    });
    const dimensions = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error("Could not load the image preview."));
      image.src = dataUrl;
    });
    return { kind: "image", name: file.name, dataUrl, mimeType: file.type, size: file.size, ...dimensions };
  }
  if (lowerName.endsWith(".pdf")) {
    const arrayBuffer = await file.arrayBuffer();
    return { kind: "pdf", name: file.name, arrayBuffer, size: file.size };
  }
  if (lowerName.endsWith(".docx")) {
    const arrayBuffer = await file.arrayBuffer();
    return { kind: "docx", name: file.name, arrayBuffer, size: file.size };
  }
  if (lowerName.endsWith(".xlsx")) {
    const arrayBuffer = await file.arrayBuffer();
    return { kind: "xlsx", name: file.name, arrayBuffer, size: file.size };
  }
  if (lowerName.endsWith(".xls")) {
    throw new Error("Legacy .xls files are intentionally unsupported in the secure browser parser. Convert the file to .xlsx first.");
  }
  const text = await file.text();
  return { kind: "text", name: file.name, text, size: file.size };
}

function selectedIds() {
  return [...selectionState];
}

function scanIsStale() {
  return inputDirtySinceScan || configDirtySinceScan;
}

function staleOutputMessage(action) {
  const reason = inputDirtySinceScan ? "content" : "scan settings";
  return `Refresh scan before ${action}. The current output was generated from older ${reason}.`;
}

function markInputDirty() {
  if (!scanState) return;
  inputDirtySinceScan = true;
  renderSelectionTrust();
  refreshActions();
  setStatus(inputStatus, "Content changed. Refresh scan to keep reviewed findings and scan the new data.", "warn");
  setStatus(outputStatus, "Output is stale because the source content changed. Refresh scan before copying or exporting.", "warn");
}

function markConfigurationDirty(label = "Scan settings") {
  if (!scanState) return;
  configDirtySinceScan = true;
  renderSelectionTrust();
  refreshActions();
  setStatus(inputStatus, `${label} changed. Refresh scan to apply the new detection settings.`, "warn");
  setStatus(outputStatus, "Output is stale because the scan configuration changed. Refresh scan before copying or exporting.", "warn");
}

async function refreshScanFromStaleState() {
  await runScan({ preserveReviewedSelection: true });
}

function findingSelectionKey(finding, { includeOffsets = true } = {}) {
  const context = finding.context || {};
  return JSON.stringify({
    label: finding.label,
    original: finding.original,
    ...(includeOffsets ? { start: finding.start, end: finding.end } : {}),
    kind: context.kind,
    previewPath: context.previewPath,
    path: context.path,
    rowIndex: context.rowIndex,
    columnIndex: context.columnIndex,
    tableIndex: context.tableIndex,
    sheetIndex: context.sheetIndex,
    segmentIndex: context.segmentIndex,
    pageNumber: context.pageNumber,
  });
}

function countedFindingKeys(findings, predicate, keyOptions) {
  const counts = new Map();
  for (const finding of findings) {
    if (!predicate(finding)) continue;
    const key = findingSelectionKey(finding, keyOptions);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function consumeFindingKey(counts, finding, keyOptions) {
  const key = findingSelectionKey(finding, keyOptions);
  const count = counts.get(key) || 0;
  if (count <= 0) return false;
  if (count === 1) counts.delete(key);
  else counts.set(key, count - 1);
  return true;
}

function restoreReviewedSelection(previousScan, previousSelected, previousRecommended) {
  const nextRecommended = new Set(scanState.findings.filter((item) => item.confidence >= autoSelectThreshold()).map((item) => item.id));
  const previousFindings = previousScan?.findings || [];
  const selectedExact = countedFindingKeys(previousFindings, (finding) => previousSelected.has(finding.id), { includeOffsets: true });
  const selectedStable = countedFindingKeys(previousFindings, (finding) => previousSelected.has(finding.id), { includeOffsets: false });
  const skippedExact = countedFindingKeys(previousFindings, (finding) => previousRecommended.has(finding.id) && !previousSelected.has(finding.id), { includeOffsets: true });
  const skippedStable = countedFindingKeys(previousFindings, (finding) => previousRecommended.has(finding.id) && !previousSelected.has(finding.id), { includeOffsets: false });

  recommendedSelectionState = nextRecommended;
  selectionState = new Set();
  for (const finding of scanState.findings) {
    const wasSelected = consumeFindingKey(selectedExact, finding, { includeOffsets: true })
      || consumeFindingKey(selectedStable, finding, { includeOffsets: false });
    const wasSkipped = !wasSelected && (
      consumeFindingKey(skippedExact, finding, { includeOffsets: true })
      || consumeFindingKey(skippedStable, finding, { includeOffsets: false })
    );
    if (wasSelected) selectionState.add(finding.id);
    else if (!wasSkipped && nextRecommended.has(finding.id)) selectionState.add(finding.id);
  }
}

function renderVisualOverlays() {
  const overlays = [...outputEl.querySelectorAll(".output-overlay")];
  if (!overlays.length || !scanState) return;

  overlays.forEach((overlay) => {
    if (!(overlay instanceof HTMLElement)) return;
    const pageNumber = Number(overlay.dataset.pageNumber || "1");
    const image = overlay.parentElement?.querySelector("img");
    if (!(image instanceof HTMLImageElement)) return;
    overlay.innerHTML = "";
    overlay.classList.toggle("drawing", manualDrawMode);

    const pageInfo = scanState.document.kind === "pdf"
      ? scanState.document.pages.find((page) => page.pageNumber === pageNumber)
      : { width: scanState.document.width, height: scanState.document.height };
    const naturalWidth = pageInfo?.width || image.naturalWidth || 1;
    const naturalHeight = pageInfo?.height || image.naturalHeight || 1;
    const displayWidth = image.clientWidth || image.width || 1;
    const displayHeight = image.clientHeight || image.height || 1;

    for (const finding of manualFindings()) {
      const box = finding.context?.bbox;
      if (!box) continue;
      if ((finding.context?.pageNumber || 1) !== pageNumber) continue;
      const element = document.createElement("div");
      element.className = `manual-box${finding.id === selectedManualFindingId ? " selected" : ""}`;
      element.dataset.findingId = finding.id;
      element.dataset.pageNumber = String(pageNumber);
      element.style.left = `${(box.x0 / naturalWidth) * displayWidth}px`;
      element.style.top = `${(box.y0 / naturalHeight) * displayHeight}px`;
      element.style.width = `${((box.x1 - box.x0) / naturalWidth) * displayWidth}px`;
      element.style.height = `${((box.y1 - box.y0) / naturalHeight) * displayHeight}px`;
      overlay.appendChild(element);
    }

    if (manualBoxDraft && manualBoxDraft.pageNumber === pageNumber) {
      const element = document.createElement("div");
      element.className = "manual-box live";
      element.style.left = `${manualBoxDraft.left}px`;
      element.style.top = `${manualBoxDraft.top}px`;
      element.style.width = `${manualBoxDraft.width}px`;
      element.style.height = `${manualBoxDraft.height}px`;
      overlay.appendChild(element);
    }
  });
}

function addManualRedactionBox(box, pageNumber = 1) {
  if (!scanState || !["image", "pdf"].includes(scanState.document.kind)) return;
  manualBoxCounter += 1;
  const finding = {
    id: `f-manual-${manualBoxCounter}`,
    label: "MANUAL_AREA",
    category: "identity",
    confidence: 1,
    start: 0,
    end: 0,
    original: "Manual blackout box",
    reasoning: ["manual_redaction_box"],
    context: {
      kind: scanState.document.kind,
      pageNumber,
      previewPath: scanState.document.kind === "pdf" ? `Page ${pageNumber}.manual_box_${manualBoxCounter}` : `manual.box_${manualBoxCounter}`,
      bbox: box,
    },
    replacement: "[REDACTED]",
  };
  scanState.findings.push(finding);
  scanState.summary = {
    total: scanState.findings.length,
    high: scanState.findings.filter((item) => item.confidence >= 0.8).length,
    medium: scanState.findings.filter((item) => item.confidence < 0.8).length,
  };
  selectionState.add(finding.id);
  recommendedSelectionState.add(finding.id);
  selectedManualFindingId = finding.id;
  renderFindings();
  renderSelectionTrust();
  syncImageToolState();
  refreshOutputFromSelection("Added a manual blackout box.").catch((error) => setStatus(outputStatus, `Refresh failed: ${error.message}`, "error"));
}

function clearManualRedactionBoxes() {
  if (!scanState) return;
  const manualIds = new Set(manualFindings().map((finding) => finding.id));
  if (!manualIds.size) return;
  scanState.findings = scanState.findings.filter((finding) => !manualIds.has(finding.id));
  selectionState = new Set([...selectionState].filter((id) => !manualIds.has(id)));
  recommendedSelectionState = new Set([...recommendedSelectionState].filter((id) => !manualIds.has(id)));
  scanState.summary = {
    total: scanState.findings.length,
    high: scanState.findings.filter((item) => item.confidence >= 0.8).length,
    medium: scanState.findings.filter((item) => item.confidence < 0.8).length,
  };
  manualBoxDraft = null;
  selectedManualFindingId = null;
  manualDragState = null;
  renderFindings();
  renderSelectionTrust();
  syncImageToolState();
  refreshOutputFromSelection("Cleared manual blackout boxes.").catch((error) => setStatus(outputStatus, `Refresh failed: ${error.message}`, "error"));
}

function updateManualFindingBox(findingId, nextBox) {
  if (!scanState) return;
  const finding = scanState.findings.find((item) => item.id === findingId);
  if (!finding) return;
  finding.context = { ...finding.context, bbox: nextBox };
}

function deleteSelectedManualBox() {
  if (!scanState || !selectedManualFindingId) return;
  const manualId = selectedManualFindingId;
  scanState.findings = scanState.findings.filter((finding) => finding.id !== manualId);
  selectionState.delete(manualId);
  recommendedSelectionState.delete(manualId);
  selectedManualFindingId = null;
  manualDragState = null;
  scanState.summary = {
    total: scanState.findings.length,
    high: scanState.findings.filter((item) => item.confidence >= 0.8).length,
    medium: scanState.findings.filter((item) => item.confidence < 0.8).length,
  };
  renderFindings();
  renderSelectionTrust();
  syncImageToolState();
  refreshOutputFromSelection("Removed the selected blackout box.").catch((error) => setStatus(outputStatus, `Refresh failed: ${error.message}`, "error"));
}

function renderFindings() {
  findingsEl.innerHTML = "";
  if (!scanState) {
    renderSummary();
    renderSelectionTrust();
    reviewEmpty.classList.remove("hidden");
    return;
  }
  const filtered = findingsForDisplay(scanState, filterSearch.value);
  renderSummary(scanState.summary);
  reviewEmpty.classList.toggle("hidden", filtered.length > 0);

  for (const finding of filtered) {
    const confidenceClass = finding.confidence >= 0.8 ? "high" : "medium";
    const wasRecommended = recommendedSelectionState.has(finding.id);
    const isSelected = selectionState.has(finding.id);
    const selectionLabel = isSelected
      ? (wasRecommended ? "Auto-selected" : "Manually selected")
      : (wasRecommended ? "Skipped manually" : "Not auto-selected");
    const wrapper = document.createElement("article");
    wrapper.className = "finding";
    wrapper.innerHTML = `
      <div class="finding-top">
        <label class="toggle"><input class="finding-select" type="checkbox" value="${finding.id}" ${isSelected ? "checked" : ""} /> Select</label>
        <span class="badge ${confidenceClass}">${finding.label}</span>
        <span class="badge ${finding.category || "pii"}">${finding.category || "other"}</span>
        <span class="badge ${confidenceClass}">${finding.confidence.toFixed(2)}</span>
        <span class="badge trust">${selectionLabel}</span>
      </div>
      <code>${escapeHtml(finding.original)}</code>
      <div class="meta">${escapeHtml(finding.context?.previewPath || finding.context?.kind || "text")} • ${escapeHtml((finding.reasoning || []).join(", ") || "matched rule")}</div>
    `;
    findingsEl.appendChild(wrapper);
  }
}

function updateSelectionFromThreshold() {
  if (!scanState) return;
  const threshold = autoSelectThreshold();
  recommendedSelectionState = new Set(scanState.findings.filter((item) => item.confidence >= threshold).map((item) => item.id));
  selectionState = new Set(recommendedSelectionState);
  renderFindings();
  renderSelectionTrust();
}

function setOutput(result) {
  outputState = result;
  if (result.isImage && result.imageDataUrl) {
    outputEl.innerHTML = `<div class="output-canvas"><img src="${result.imageDataUrl}" alt="Redacted output preview" /><div class="output-overlay" data-page-number="1"></div></div>`;
  } else if (result.isPdf && Array.isArray(result.pdfPages)) {
    outputEl.innerHTML = `<div class="output-pages">${result.pdfPages.map((page) => `
      <div class="output-canvas pdf-page">
        <div class="page-label">Page ${page.pageNumber}</div>
        <img src="${page.dataUrl}" alt="Redacted PDF page ${page.pageNumber}" />
        <div class="output-overlay" data-page-number="${page.pageNumber}"></div>
      </div>`).join("")}</div>`;
  } else {
    outputEl.textContent = result.text;
  }
  outputEl.querySelectorAll("img").forEach((image) => {
    image.addEventListener("load", () => renderVisualOverlays(), { once: true });
  });
  renderFormatNote(result.formatInfo, outputNote);
  refreshActions();
  renderSelectionTrust();
  syncImageToolState();
  renderVisualOverlays();
}

async function refreshOutputFromSelection(statusMessage = "") {
  if (!scanState) return null;
  const result = await redactDocument(scanState, selectedIds(), modeSelect.value);
  setOutput(result);
  if (statusMessage) setStatus(outputStatus, statusMessage, "success");
  return result;
}

async function runScan({ preserveReviewedSelection = false } = {}) {
  const previousScan = preserveReviewedSelection ? scanState : null;
  const previousSelected = preserveReviewedSelection ? new Set(selectionState) : new Set();
  const previousRecommended = preserveReviewedSelection ? new Set(recommendedSelectionState) : new Set();
  const documentModel = await currentDocument();
  const options = currentOptions();
  manualDrawMode = false;
  manualBoxDraft = null;
  if (documentModel.kind === "image") {
    setStatus(inputStatus, "Running OCR locally in your browser. The first image can take a little while.", "warn");
  } else if (documentModel.kind === "pdf") {
    setStatus(inputStatus, "Rendering and scanning PDF pages locally in your browser.", "warn");
  }
  scanState = await scanDocument(documentModel, options);
  if (deepScan.checked && scanState.preview) {
    setStatus(inputStatus, "Deep scan: running the AI model locally in your browser.", "warn");
    options.modelEntities = await deepScanEntities(scanState.preview, reportDeepScanProgress);
    // ponytail: rescans the whole document (images re-run OCR); pass OCR results through if that gets slow
    if (options.modelEntities.length) scanState = await scanDocument(documentModel, options);
  }
  if (preserveReviewedSelection && previousScan) {
    restoreReviewedSelection(previousScan, previousSelected, previousRecommended);
    renderFindings();
    renderSelectionTrust();
  } else {
    updateSelectionFromThreshold();
  }
  inputDirtySinceScan = false;
  configDirtySinceScan = false;
  renderFormatNote(scanState.formatInfo, formatNote);
  await refreshOutputFromSelection();

  let scanMessage = `Scan complete. ${scanState.summary.total} findings detected locally in your browser${deepScan.checked ? " with deep scan" : ""}.`;
  let scanType = "success";

  if (scanState.autoDetection?.source === "fallback") {
    scanMessage += ` Auto-detected as ${scanState.autoDetection.selectedKind} after a plain-text scan found nothing.`;
  } else if (scanState.document?.autoDetection?.kind && scanState.document?.autoDetection?.kind !== scanState.document.kind) {
    scanMessage += ` Input was treated as ${scanState.document.autoDetection.kind}.`;
  }

  if (scanState.summary.total === 0 && ["text", "yaml", "table", "json", "docx", "xlsx"].includes(documentModel.kind)) {
    const broadScan = await scanDocument(documentModel, broadDiagnosticOptions());
    if (broadScan.summary.total > 0) {
      const mutedAreas = [];
      const categories = currentEnabledCategories();
      if (!options.detectNames || categories.identity === false) mutedAreas.push("names and places");
      if (categories.pii === false) mutedAreas.push("emails and direct identifiers");
      if (categories.financial === false) mutedAreas.push("financial data");
      if (categories.network === false) mutedAreas.push("network identifiers");
      if (categories.secrets === false) mutedAreas.push("secrets");
      const mutedLabel = mutedAreas.length ? ` The current scan settings are narrowing or disabling ${mutedAreas.join(", ")}.` : "";
      scanMessage = `Scan complete. 0 findings detected with the current settings, but a broader scan would have found ${broadScan.summary.total}.${mutedLabel}`;
      scanType = "warn";
    }
  }

  setStatus(inputStatus, scanMessage, scanType);
  setStatus(outputStatus, "Review the findings or copy the current output right away.", "");
  refreshActions();
}

function applySelected() {
  if (!scanState) {
    setStatus(outputStatus, "Run a scan first so there is something to apply.", "warn");
    return null;
  }
  return refreshOutputFromSelection(`Applied ${selectedIds().length} selected findings.`);
}

async function copyOutput(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus(outputStatus, successMessage, "success");
  } catch (error) {
    setStatus(outputStatus, `Copy failed: ${error.message}`, "error");
  }
}

function runBenchmark() {
  const options = currentOptions();
  const results = benchmarkCorpus.map((testCase) => {
    const findings = scanTextValue(testCase.text, options, { keyHint: testCase.keyHint || "", previewPath: "benchmark" });
    const matched = findings.some((finding) => finding.label === testCase.label);
    return { ...testCase, matched, findings };
  });
  const hitCount = results.filter((item) => item.matched).length;
  benchmarkTotal.textContent = String(results.length);
  benchmarkHit.textContent = String(hitCount);
  benchmarkRate.textContent = `${Math.round((hitCount / Math.max(1, results.length)) * 100)}%`;
  const byCategory = new Map();
  for (const item of results) {
    if (!byCategory.has(item.category)) byCategory.set(item.category, { total: 0, hit: 0 });
    const bucket = byCategory.get(item.category);
    bucket.total += 1;
    if (item.matched) bucket.hit += 1;
  }
  benchmarkBreakdown.textContent = [...byCategory.entries()]
    .map(([category, stats]) => `${category}: ${stats.hit}/${stats.total}`)
    .join(" • ");
  benchmarkResults.classList.remove("empty");
  benchmarkResults.innerHTML = results.map((item) => `${item.matched ? "PASS" : "MISS"}  ${item.label.padEnd(16, " ")}  ${item.text}`).join("\n");
  setStatus(benchmarkStatus, `${hitCount} of ${results.length} benchmark samples matched with the current detector settings.`, hitCount === results.length ? "success" : "warn");
}

document.querySelector("#scan-button").addEventListener("click", async () => {
  try {
    await runScan({ preserveReviewedSelection: Boolean(scanState) });
  } catch (error) {
    setStatus(inputStatus, `Scan failed: ${error.message}`, "error");
  }
});

refreshScanButton?.addEventListener("click", async () => {
  try {
    await refreshScanFromStaleState();
  } catch (error) {
    setStatus(inputStatus, `Refresh scan failed: ${error.message}`, "error");
  }
});

stickyRefreshScanButton?.addEventListener("click", async () => {
  try {
    await refreshScanFromStaleState();
  } catch (error) {
    setStatus(inputStatus, `Refresh scan failed: ${error.message}`, "error");
  }
});

document.querySelector("#apply-button").addEventListener("click", async () => {
  try {
    await applySelected();
  } catch (error) {
    setStatus(outputStatus, `Apply failed: ${error.message}`, "error");
  }
});

document.querySelector("#safe-copy-button").addEventListener("click", async () => {
  try {
    await runScan({ preserveReviewedSelection: Boolean(scanState) });
    const result = await refreshOutputFromSelection();
    if (result?.copyable !== false && result?.text) {
      await copyOutput(result.text, "LLM-safe output copied to your clipboard.");
    } else {
      setStatus(outputStatus, scanState?.document?.kind === "pdf"
        ? "PDF redaction ready. Use export to save the black-barred PDF."
        : "Image redaction ready. Use export to save the black-boxed image.", "success");
    }
  } catch (error) {
    setStatus(outputStatus, `LLM-safe copy failed: ${error.message}`, "error");
  }
});
stickySafeCopyButton.addEventListener("click", async () => {
  try {
    await runScan({ preserveReviewedSelection: Boolean(scanState) });
    const result = await refreshOutputFromSelection();
    if (result?.copyable !== false && result?.text) {
      await copyOutput(result.text, "LLM-safe output copied to your clipboard.");
    } else {
      setStatus(outputStatus, scanState?.document?.kind === "pdf"
        ? "PDF redaction ready. Use export to save the black-barred PDF."
        : "Image redaction ready. Use export to save the black-boxed image.", "success");
    }
  } catch (error) {
    setStatus(outputStatus, `LLM-safe copy failed: ${error.message}`, "error");
  }
});

document.querySelector("#copy-button").addEventListener("click", async () => {
  if (!outputState?.text) return;
  if (scanIsStale()) {
    setStatus(outputStatus, staleOutputMessage("copying"), "warn");
    return;
  }
  const hasResidualRisk = Boolean(scanState && scanState.findings.length > selectionState.size);
  await copyOutput(outputState.text, hasResidualRisk ? "Output copied. Some findings still remain outside the current output." : "Output copied to your clipboard.");
});
stickyCopyButton.addEventListener("click", async () => {
  if (!outputState?.text) return;
  if (scanIsStale()) {
    setStatus(outputStatus, staleOutputMessage("copying"), "warn");
    return;
  }
  const hasResidualRisk = Boolean(scanState && scanState.findings.length > selectionState.size);
  await copyOutput(outputState.text, hasResidualRisk ? "Output copied. Some findings still remain outside the current output." : "Output copied to your clipboard.");
});

document.querySelector("#download-button").addEventListener("click", () => {
  if (!outputState) return;
  if (scanIsStale()) {
    setStatus(outputStatus, staleOutputMessage("exporting"), "warn");
    return;
  }
  const downloadName = outputState.fileName?.startsWith("redacted_") ? outputState.fileName : `redacted_${outputState.fileName || "output.txt"}`;
  const link = document.createElement("a");
  let objectUrl = "";
  if (outputState.isImage && outputState.imageDataUrl) {
    link.href = outputState.imageDataUrl;
  } else if (outputState.binaryData) {
    const blob = new Blob([outputState.binaryData], { type: outputState.blobType || mimeTypeForFile(downloadName) });
    objectUrl = URL.createObjectURL(blob);
    link.href = objectUrl;
  } else {
    const blob = new Blob([outputState.text], { type: mimeTypeForFile(downloadName) });
    objectUrl = URL.createObjectURL(blob);
    link.href = objectUrl;
  }
  link.download = downloadName;
  link.click();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  setStatus(outputStatus, scanState && scanState.findings.length > selectionState.size ? "File downloaded, but some findings remain outside the current output." : "Redacted file downloaded locally.", scanState && scanState.findings.length > selectionState.size ? "warn" : "success");
});
stickyDownloadButton.addEventListener("click", () => {
  if (!outputState) return;
  if (scanIsStale()) {
    setStatus(outputStatus, staleOutputMessage("exporting"), "warn");
    return;
  }
  document.querySelector("#download-button").click();
});

document.querySelector("#benchmark-button").addEventListener("click", runBenchmark);

clearButton.addEventListener("click", () => {
  secureSessionWipe().catch((error) => {
    clearButton.disabled = false;
    setStatus(inputStatus, `Secure wipe failed: ${error.message}`, "error");
  });
});

if (outputExpandButton) {
  outputExpandButton.addEventListener("click", () => {
    openFocusPanel("output");
  });
}

if (reviewExpandButton) {
  reviewExpandButton.addEventListener("click", () => {
    openFocusPanel("review");
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && activeFocusKind) {
    closeFocusPanel();
  }
});

document.querySelector("#select-all-button").addEventListener("click", () => {
  selectionState = new Set((scanState?.findings || []).map((item) => item.id));
  renderFindings();
  renderSelectionTrust();
  refreshOutputFromSelection().catch((error) => setStatus(outputStatus, `Refresh failed: ${error.message}`, "error"));
});

document.querySelector("#select-none-button").addEventListener("click", () => {
  selectionState = new Set();
  renderFindings();
  renderSelectionTrust();
  refreshOutputFromSelection().catch((error) => setStatus(outputStatus, `Refresh failed: ${error.message}`, "error"));
});

presetSelect.addEventListener("change", () => {
  applyPreset(presetSelect.value);
  if (scanState) updateSelectionFromThreshold();
  markConfigurationDirty("Workflow preset");
});

confidenceSelect.addEventListener("change", () => {
  updateSelectionFromThreshold();
  refreshOutputFromSelection().catch((error) => setStatus(outputStatus, `Refresh failed: ${error.message}`, "error"));
});
modeSelect.addEventListener("change", () => {
  if (scanState) refreshOutputFromSelection().catch((error) => setStatus(outputStatus, `Refresh failed: ${error.message}`, "error"));
});
strictEmail.addEventListener("change", () => {
  markConfigurationDirty("Email matching");
});
detectNames.addEventListener("change", () => {
  markConfigurationDirty("Identity detection");
});
deepScan.addEventListener("change", () => {
  markConfigurationDirty("Deep scan");
});
if (!deepScanSupported) {
  deepScan.disabled = true;
  document.querySelector("#deep-scan-note").textContent = "Needs a browser with WebGPU, such as current Chrome, Edge, or Safari.";
}
detectFaces.addEventListener("change", () => {
  markConfigurationDirty("Face detection");
});
imageModeSelect.addEventListener("change", () => {
  markConfigurationDirty("Image workflow");
});
categoryToggles.forEach((toggle) => {
  toggle.addEventListener("change", () => {
    markConfigurationDirty("Detection scope");
  });
});
filterSearch.addEventListener("input", renderFindings);
findingsEl.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !target.classList.contains("finding-select")) return;
  if (target.checked) selectionState.add(target.value);
  else selectionState.delete(target.value);
  renderSelectionTrust();
  refreshOutputFromSelection().catch((error) => setStatus(outputStatus, `Refresh failed: ${error.message}`, "error"));
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) {
    fileState = null;
    fileSummary.textContent = "No file selected.";
    return;
  }
  try {
    fileState = await readInputFile(file);
    manualDrawMode = false;
    manualBoxDraft = null;
    selectedManualFindingId = null;
    manualDragState = null;
    markInputDirty();
    fileSummary.textContent = `${fileState.name} loaded locally (${Math.round(fileState.size / 1024) || 1} KB). Pasted text is ignored while a file is selected.`;
    renderFormatNote(lightweightFormatInfo(fileState, fileState.name), formatNote);
    setStatus(inputStatus, scanState
      ? "File loaded locally. Refresh scan to keep reviewed findings, or use LLM-safe copy for the fastest workflow."
      : "File loaded locally. Click LLM-safe copy for the fastest workflow.", "success");
  } catch (error) {
    fileState = null;
    setStatus(inputStatus, `Could not read file: ${error.message}`, "error");
  }
});

document.addEventListener("paste", async (event) => {
  const items = [...(event.clipboardData?.items || [])];
  const imageItem = items.find((item) => item.type.startsWith("image/"));
  if (!imageItem) return;
  const file = imageItem.getAsFile();
  if (!file) return;
  event.preventDefault();
  try {
    fileState = await readInputFile(file);
    manualDrawMode = false;
    manualBoxDraft = null;
    selectedManualFindingId = null;
    manualDragState = null;
    markInputDirty();
    fileSummary.textContent = `${fileState.name} pasted from clipboard. OCR will run locally in the browser.`;
    renderFormatNote(lightweightFormatInfo(fileState, fileState.name), formatNote);
    setStatus(inputStatus, scanState
      ? "Image pasted from clipboard. Refresh scan to keep reviewed findings, or use LLM-safe copy to process it."
      : "Image pasted from clipboard. Click scan or LLM-safe copy to process it.", "success");
  } catch (error) {
    setStatus(inputStatus, `Could not read pasted image: ${error.message}`, "error");
  }
});

textInput.addEventListener("input", () => {
  if (fileState) return;
  markInputDirty();
  currentDocument().then((documentModel) => {
    renderFormatNote(documentModel.formatInfo, formatNote);
  }).catch(() => {
    formatNote.textContent = "Format recognition will appear here once the input parses cleanly.";
  });
});

manualBoxButton.addEventListener("click", () => {
  if (!scanState || !["image", "pdf"].includes(scanState.document.kind)) return;
  manualDrawMode = !manualDrawMode;
  manualBoxDraft = null;
  manualDragState = null;
  syncImageToolState();
  renderVisualOverlays();
  setStatus(outputStatus, manualDrawMode ? "Drag on the page preview to add blackout boxes." : "Manual blackout mode turned off.", manualDrawMode ? "warn" : "");
});

deleteManualBoxButton.addEventListener("click", () => {
  deleteSelectedManualBox();
});

clearManualBoxesButton.addEventListener("click", () => {
  clearManualRedactionBoxes();
});

outputEl.addEventListener("pointerdown", (event) => {
  if (!scanState || !["image", "pdf"].includes(scanState.document.kind)) return;
  const manualBox = event.target instanceof Element ? event.target.closest(".manual-box") : null;
  if (manualBox instanceof HTMLElement) {
    selectedManualFindingId = manualBox.dataset.findingId || null;
    const overlay = manualBox.closest(".output-overlay");
    if (!(overlay instanceof HTMLElement) || !selectedManualFindingId) {
      renderVisualOverlays();
      syncImageToolState();
      return;
    }
    const pageNumber = Number(overlay.dataset.pageNumber || "1");
    const image = overlay.parentElement?.querySelector("img");
    if (!(image instanceof HTMLImageElement)) {
      renderVisualOverlays();
      syncImageToolState();
      return;
    }
    const rect = overlay.getBoundingClientRect();
    const pageInfo = scanState.document.kind === "pdf"
      ? scanState.document.pages.find((page) => page.pageNumber === pageNumber)
      : { width: scanState.document.width, height: scanState.document.height };
    const naturalWidth = pageInfo?.width || image.naturalWidth || 1;
    const naturalHeight = pageInfo?.height || image.naturalHeight || 1;
    const finding = scanState.findings.find((item) => item.id === selectedManualFindingId);
    const box = finding?.context?.bbox;
    if (box) {
      manualDragState = {
        findingId: selectedManualFindingId,
        pageNumber,
        startClientX: event.clientX,
        startClientY: event.clientY,
        originalBox: { ...box },
        scaleX: naturalWidth / rect.width,
        scaleY: naturalHeight / rect.height,
        pageWidth: naturalWidth,
        pageHeight: naturalHeight,
      };
    }
    renderVisualOverlays();
    syncImageToolState();
    return;
  }
  if (!manualDrawMode) {
    selectedManualFindingId = null;
    manualDragState = null;
    renderVisualOverlays();
    syncImageToolState();
    return;
  }
  const overlay = event.target instanceof Element ? event.target.closest(".output-overlay") : null;
  if (!(overlay instanceof HTMLElement)) return;
  const rect = overlay.getBoundingClientRect();
  manualBoxDraft = {
    pageNumber: Number(overlay.dataset.pageNumber || "1"),
    startX: Math.min(Math.max(event.clientX - rect.left, 0), rect.width),
    startY: Math.min(Math.max(event.clientY - rect.top, 0), rect.height),
    left: Math.min(Math.max(event.clientX - rect.left, 0), rect.width),
    top: Math.min(Math.max(event.clientY - rect.top, 0), rect.height),
    width: 0,
    height: 0,
  };
  renderVisualOverlays();
});

outputEl.addEventListener("pointermove", (event) => {
  if (manualDragState && scanState) {
    const deltaX = (event.clientX - manualDragState.startClientX) * manualDragState.scaleX;
    const deltaY = (event.clientY - manualDragState.startClientY) * manualDragState.scaleY;
    const box = manualDragState.originalBox;
    const width = box.x1 - box.x0;
    const height = box.y1 - box.y0;
    const x0 = Math.min(Math.max(0, box.x0 + deltaX), Math.max(0, manualDragState.pageWidth - width));
    const y0 = Math.min(Math.max(0, box.y0 + deltaY), Math.max(0, manualDragState.pageHeight - height));
    updateManualFindingBox(manualDragState.findingId, {
      x0,
      y0,
      x1: x0 + width,
      y1: y0 + height,
    });
    renderVisualOverlays();
    return;
  }
  if (!manualDrawMode || !manualBoxDraft) return;
  const overlay = outputEl.querySelector(`.output-overlay[data-page-number="${manualBoxDraft.pageNumber}"]`);
  if (!(overlay instanceof HTMLElement)) return;
  const rect = overlay.getBoundingClientRect();
  const currentX = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
  const currentY = Math.min(Math.max(event.clientY - rect.top, 0), rect.height);
  manualBoxDraft.left = Math.min(manualBoxDraft.startX, currentX);
  manualBoxDraft.top = Math.min(manualBoxDraft.startY, currentY);
  manualBoxDraft.width = Math.abs(currentX - manualBoxDraft.startX);
  manualBoxDraft.height = Math.abs(currentY - manualBoxDraft.startY);
  renderVisualOverlays();
});

outputEl.addEventListener("pointerup", () => {
  if (manualDragState) {
    manualDragState = null;
    refreshOutputFromSelection("Moved the selected blackout box.").catch((error) => setStatus(outputStatus, `Refresh failed: ${error.message}`, "error"));
    renderVisualOverlays();
    syncImageToolState();
    return;
  }
  if (!manualDrawMode || !manualBoxDraft || !scanState || !["image", "pdf"].includes(scanState.document.kind)) return;
  const overlay = outputEl.querySelector(`.output-overlay[data-page-number="${manualBoxDraft.pageNumber}"]`);
  const image = overlay?.parentElement?.querySelector("img");
  if (!(overlay instanceof HTMLElement) || !(image instanceof HTMLImageElement)) return;
  const rect = overlay.getBoundingClientRect();
  const pageInfo = scanState.document.kind === "pdf"
    ? scanState.document.pages.find((page) => page.pageNumber === manualBoxDraft.pageNumber)
    : { width: scanState.document.width, height: scanState.document.height };
  const naturalWidth = pageInfo?.width || image.naturalWidth || 1;
  const naturalHeight = pageInfo?.height || image.naturalHeight || 1;
  if (manualBoxDraft.width >= 12 && manualBoxDraft.height >= 12) {
    addManualRedactionBox({
      x0: (manualBoxDraft.left / rect.width) * naturalWidth,
      y0: (manualBoxDraft.top / rect.height) * naturalHeight,
      x1: ((manualBoxDraft.left + manualBoxDraft.width) / rect.width) * naturalWidth,
      y1: ((manualBoxDraft.top + manualBoxDraft.height) / rect.height) * naturalHeight,
    }, manualBoxDraft.pageNumber);
  }
  manualBoxDraft = null;
  renderVisualOverlays();
});

refreshActions();
applyPreset(presetSelect.value);
renderSelectionTrust();
syncImageToolState();
window.addEventListener("beforeunload", () => {
  shutdownImageWorker().catch(() => {});
});
