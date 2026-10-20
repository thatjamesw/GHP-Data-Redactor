import { applyTextReplacements } from "../replacements.js";
import { annotateFindings, loadVendorScript, summarise } from "../utils.js";
import { scanTextValue } from "../detectors.js";

const MAMMOTH_SCRIPT_PATH = "./static/vendor/mammoth/mammoth.browser.min.js";

let mammothPromise = null;

async function ensureMammoth() {
  if (mammothPromise) return mammothPromise;
  mammothPromise = (async () => {
    if (typeof document === "undefined") {
      const imported = await import("mammoth");
      return imported.default || imported;
    }
    return loadVendorScript(MAMMOTH_SCRIPT_PATH, "mammoth", (lib) => lib?.extractRawText);
  })();
  return mammothPromise;
}

export async function prepareDocxDocument(fileState) {
  const mammoth = await ensureMammoth();
  const { value, messages } = await mammoth.extractRawText({ arrayBuffer: fileState.arrayBuffer.slice(0) });
  const content = String(value || "").replace(/\r\n/g, "\n").trim();
  return {
    kind: "docx",
    name: fileState.name || "document.docx",
    content,
    messages: messages || [],
    formatInfo: {
      label: "DOCX (text extraction)",
      guarantee: "Document text is extracted locally and exported as cleaned text. Original DOCX layout and styling are not rewritten yet.",
    },
  };
}

export function scanDocxDocument(document, options = {}) {
  const findings = annotateFindings(scanTextValue(document.content, options, { kind: "docx", previewPath: document.name }));
  return {
    document,
    findings,
    summary: summarise(findings),
    preview: document.content,
    formatInfo: document.formatInfo,
  };
}

export function redactDocxDocument(scanResult, selectedIds, mode) {
  return {
    text: applyTextReplacements(scanResult.document.content, scanResult.findings, new Set(selectedIds), mode),
    fileName: scanResult.document.name.replace(/\.docx$/i, "") + "-redacted.txt",
    formatInfo: scanResult.formatInfo,
  };
}
