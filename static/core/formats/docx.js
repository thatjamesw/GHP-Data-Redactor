import { applyTextReplacements } from "../replacements.js";
import { annotateFindings, summarise } from "../utils.js";
import { readZipText } from "../zip.js";
import { scanTextValue } from "../detectors.js";

const XML_ENTITIES = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };

function decodeXml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, entity) => {
    if (entity[0] !== "#") return XML_ENTITIES[entity] ?? match;
    return String.fromCodePoint(entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
  });
}

// Same output shape as mammoth's extractRawText: run text, tabs and breaks, each paragraph followed by a blank line.
export function docxBodyText(xml) {
  const body = xml.replace(/<w:pPr\b[\s\S]*?<\/w:pPr>/g, "");
  let text = "";
  for (const match of body.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>|<\/w:p>/g)) {
    if (match[1] !== undefined) text += decodeXml(match[1]);
    else if (match[0].startsWith("<w:tab")) text += "\t";
    else if (match[0].startsWith("</")) text += "\n\n";
    else text += "\n";
  }
  return text;
}

export async function prepareDocxDocument(fileState) {
  const xml = await readZipText(fileState.arrayBuffer.slice(0), "word/document.xml");
  if (xml == null) throw new Error("This DOCX file has no word/document.xml.");
  return {
    kind: "docx",
    name: fileState.name || "document.docx",
    content: docxBodyText(xml).replace(/\r\n/g, "\n").trim(),
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
