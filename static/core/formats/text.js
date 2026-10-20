import { applyTextReplacements } from "../replacements.js";
import { scanValueCollectionWithIdentitySeeds } from "../scan-helpers.js";
import { annotateFindings, ascendingFindingOrder, dedupeFindings, detectLineEnding, summarise } from "../utils.js";
import { scanTextValue } from "../detectors.js";

const DESCRIPTOR_HEADERS = new Set([
  "alert", "alert family", "capability", "channel", "component", "date", "definition", "dr field", "environment",
  "escalate after", "escalate when", "field", "frequency", "impact", "method", "minimum role", "mitigation",
  "ongoing updates", "ops scope", "owner", "primary component", "purpose", "required ops action", "retention",
  "risk", "role", "severity", "system", "trigger", "type", "use", "version", "workflow",
]);

const TABLE_DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const CODE_FENCE = /^\s{0,3}(?:```|~~~)/;
// Blockquote markers and list markers in front of a table row: "> | a |", "> > | a |", "1. | a |", "- > | a |".
const CONTAINER_PREFIX = /^(?:[ \t]*(?:>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t]+(?=[|>])))*/;

// Cell text as a markdown renderer would show it: links reduced to their text, emphasis and code ticks dropped.
function inlinePlainText(raw) {
  return raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/(^|\s)[*_]+|[*_]+(?=\s|$)/g, "$1")
    .trim();
}

function tableCell(raw, start) {
  const text = inlinePlainText(raw);
  if (!text) return null;
  const offset = raw.indexOf(text);
  if (offset >= 0) return { text, start: start + offset, end: start + offset + text.length, original: text };
  const leading = raw.length - raw.trimStart().length;
  const original = raw.trim();
  return { text, start: start + leading, end: start + leading + original.length, original };
}

function tableRowCells(line, lineStart) {
  const bounds = [];
  let cellStart = 0;
  for (let index = 0; index <= line.length; index += 1) {
    if (index < line.length && (line[index] !== "|" || line[index - 1] === "\\")) continue;
    bounds.push([cellStart, index]);
    cellStart = index + 1;
  }
  if (line.trimStart().startsWith("|")) bounds.shift();
  if (/(?:^|[^\\])\|\s*$/.test(line)) bounds.pop();
  return bounds.map(([from, to]) => tableCell(line.slice(from, to), lineStart + from));
}

// GFM tables: a header row, a matching delimiter row, then rows until a blank line.
// Tables inside blockquotes and list items are read with their container markers stripped.
function markdownTables(source) {
  const lines = [];
  let offset = 0;
  for (const text of source.split("\n")) {
    const prefix = text.match(CONTAINER_PREFIX)[0].length;
    lines.push({ text: text.slice(prefix).replace(/\r$/, ""), start: offset + prefix });
    offset += text.length + 1;
  }

  const tables = [];
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (CODE_FENCE.test(line.text)) {
      inFence = !inFence;
      continue;
    }
    const delimiter = lines[index + 1];
    if (inFence || !line.text.includes("|") || !delimiter || !TABLE_DELIMITER_ROW.test(delimiter.text)) continue;
    const header = tableRowCells(line.text, line.start);
    if (header.length !== tableRowCells(delimiter.text, delimiter.start).length) continue;

    const rows = [];
    index += 2;
    while (index < lines.length && lines[index].text.trim() && !CODE_FENCE.test(lines[index].text)) {
      rows.push(tableRowCells(lines[index].text, lines[index].start).slice(0, header.length));
      index += 1;
    }
    index -= 1;
    tables.push({ header, rows });
  }
  return tables;
}

function collapseNestedFindings(findings) {
  return findings
    .slice()
    .sort((left, right) => left.start - right.start || right.end - left.end || right.confidence - left.confidence)
    .filter((candidate, index, ordered) => !ordered.some((other, otherIndex) => {
      if (otherIndex === index) return false;
      if (other.label !== candidate.label) return false;
      if (other.start > candidate.start || other.end < candidate.end) return false;
      if (other.start === candidate.start && other.end === candidate.end) return other.confidence > candidate.confidence;
      return true;
    }));
}

function collapseDuplicateRanges(findings) {
  const bestByRange = new Map();
  for (const finding of findings) {
    const key = `${finding.start}:${finding.end}`;
    const current = bestByRange.get(key);
    if (!current || finding.confidence > current.confidence || (finding.confidence === current.confidence && finding.label < current.label)) {
      bestByRange.set(key, finding);
    }
  }
  return [...bestByRange.values()];
}

function finalizeTextFindings(findings) {
  return collapseNestedFindings(dedupeFindings(collapseDuplicateRanges(findings))).sort(ascendingFindingOrder);
}

function normalizedHeader(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function markdownTableFindings(source, options, kind) {
  const findings = [];
  const cells = [];
  markdownTables(source).forEach(({ header, rows: dataRows }, currentTableIndex) => {
    if (!dataRows.length) return;

    const headers = header.map((cell, columnIndex) => cell?.text || `column_${columnIndex + 1}`);
    const normalizedHeaders = headers.map((header) => normalizedHeader(header));
    const fieldValueTable = normalizedHeaders.length === 2 && normalizedHeaders[0] === "field" && normalizedHeaders[1] === "value";
    dataRows.forEach((row, rowIndex) => {
      const rowCells = row;
      const emailIndex = rowCells.findIndex((cell) => cell && /^[A-Za-z0-9._%+\-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$/.test(cell.text));
      const phoneIndex = rowCells.findIndex((cell) => {
        if (!cell || !/^[+\d(][\d\s().-]{6,}$/.test(cell.text)) return false;
        const digits = cell.text.replace(/\D/g, "");
        return cell.text.trim().startsWith("+") || digits.length >= 10;
      });
      const contactAnchorIndex = emailIndex !== -1 ? emailIndex : phoneIndex;

      row.forEach((cellData, columnIndex) => {
        if (!cellData) return;

        const header = headers[columnIndex] || `column_${columnIndex + 1}`;
        if (fieldValueTable && columnIndex === 0) return;
        const contextHeader = fieldValueTable && columnIndex === 1 && rowCells[0]?.text ? rowCells[0].text : header;
        const descriptorColumn = DESCRIPTOR_HEADERS.has(normalizedHeader(header));
        const profileHints = [];
        if (!descriptorColumn && contactAnchorIndex !== -1 && columnIndex === contactAnchorIndex - 1 && /^[\p{Script=Latin}\p{M}][\p{Script=Latin}\p{M}.'\u2019-]+(?:\s+[\p{Script=Latin}\p{M}][\p{Script=Latin}\p{M}.'\u2019-]+){1,3}$/u.test(cellData.text)) {
          profileHints.push("PERSON");
        }
        if (!descriptorColumn && contactAnchorIndex !== -1 && columnIndex > contactAnchorIndex && /^[\p{Script=Latin}\p{M}][\p{Script=Latin}\p{M}.'\u2019-]+(?:\s+[\p{Script=Latin}\p{M}][\p{Script=Latin}\p{M}.'\u2019-]+){0,2}$/u.test(cellData.text)) {
          profileHints.push("PLACE");
        }
        cells.push({
          cellData,
          header,
          rowIndex,
          columnIndex,
          tableIndex: currentTableIndex,
          value: cellData.text,
          context: {
            kind,
            keyHint: contextHeader,
            previewPath: `row ${rowIndex + 1}.${contextHeader}`,
            rowIndex,
            columnIndex,
            tableIndex: currentTableIndex,
            disableProfile: descriptorColumn || fieldValueTable,
            profileHints,
          },
        });
      });
    });
  });

  for (const finding of scanValueCollectionWithIdentitySeeds(cells, options)) {
    const cell = cells.find((entry) => entry.tableIndex === finding.context?.tableIndex && entry.rowIndex === finding.context?.rowIndex && entry.columnIndex === finding.context?.columnIndex);
    if (!cell) continue;
    findings.push({
      ...finding,
      start: cell.cellData.start + finding.start,
      end: cell.cellData.start + finding.end,
      original: cell.cellData.original.slice(finding.start, finding.end) || finding.original,
    });
  }

  return findings;
}

function headerlessPipeRowFindings(source, options, kind) {
  const findings = [];
  const lines = source.split(/\r?\n/);
  let offset = 0;

  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;

    if ((line.match(/\|/g) || []).length < 6) continue;
    if (/^\s*\|?\s*:?-{2,}:?/.test(line)) continue;

    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 5) continue;

    const cellMeta = [];
    let searchFrom = 0;
    for (const rawCell of cells) {
      if (!rawCell) continue;
      const index = line.indexOf(rawCell, searchFrom);
      if (index === -1) continue;
      cellMeta.push({
        text: rawCell,
        start: lineStart + index,
      });
      searchFrom = index + rawCell.length;
    }

    const hasEmail = cellMeta.some((cell) => /^[A-Za-z0-9._%+\-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$/.test(cell.text));
    const hasPhone = cellMeta.some((cell) => /^[+\d(][\d\s().-]{6,}$/.test(cell.text));
    if (!hasEmail && !hasPhone) continue;

    for (const cell of cellMeta) {
      if (!/^[\p{Script=Latin}\p{M}][\p{Script=Latin}\p{M}.'\u2019-]+(?:\s+[\p{Script=Latin}\p{M}][\p{Script=Latin}\p{M}.'\u2019-]+){1,3}$/u.test(cell.text)) continue;
      if (/^(?:CTO|IT|CEO|CFO|COO|Project Manager|Manager|Owner|Service Owner|Customer primary|Customer secondary)$/i.test(cell.text)) continue;
      findings.push({
        id: `f-h-${findings.length + 1}`,
        label: "PERSON",
        category: "identity",
        confidence: 0.8,
        start: cell.start,
        end: cell.start + cell.text.length,
        original: cell.text,
        reasoning: ["pipe_row_person_context"],
        context: {
          kind,
          previewPath: "pipe_row",
        },
      });
    }
  }

  return findings;
}

export function prepareTextDocument(text, name = "pasted.txt") {
  return {
    kind: "text",
    name,
    content: text,
    lineEnding: detectLineEnding(text),
    trailingNewline: /\r?\n$/.test(text),
    formatInfo: {
      label: "Text",
      guarantee: "Whitespace and line breaks are preserved except where matched values are replaced.",
    },
  };
}

export function scanTextDocument(document, options = {}) {
  const findings = finalizeTextFindings([
    ...scanTextValue(document.content, options, { kind: document.kind }),
    ...headerlessPipeRowFindings(document.content, options, document.kind),
    ...markdownTableFindings(document.content, options, document.kind),
  ]);
  const deduped = findings.filter((item, index) => {
    const previous = findings[index - 1];
    return !previous || previous.start !== item.start || previous.end !== item.end || previous.label !== item.label;
  });
  const annotated = annotateFindings(deduped);
  return { document, findings: annotated, summary: summarise(annotated), preview: document.content, formatInfo: document.formatInfo };
}

export function redactTextDocument(scanResult, selectedIds, mode) {
  return {
    text: applyTextReplacements(scanResult.document.content, scanResult.findings, new Set(selectedIds), mode),
    fileName: scanResult.document.name,
    formatInfo: scanResult.formatInfo,
  };
}
