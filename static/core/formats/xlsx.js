import { collapseOverlappingReplacements, replacementFor } from "../replacements.js";
import { scanValueCollectionWithIdentitySeeds } from "../scan-helpers.js";
import { annotateFindings, descendingReplacementOrder, loadVendorScript, summarise } from "../utils.js";

const EXCELJS_SCRIPT_PATH = "./static/vendor/exceljs/exceljs.min.js";

async function ensureExcelJs() {
  if (typeof document === "undefined") {
    const imported = await import("exceljs");
    return imported.default || imported;
  }

  return loadVendorScript(EXCELJS_SCRIPT_PATH, "ExcelJS", (lib) => lib?.Workbook);
}

function cellDisplayValue(cell) {
  const value = cell?.value;
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value?.richText)) return value.richText.map((part) => part.text || "").join("");
  if (typeof value?.text === "string") return value.text;
  if (typeof value?.hyperlink === "string") return typeof value.text === "string" ? value.text : value.hyperlink;
  if (typeof value?.result !== "undefined" && value.result != null) return String(value.result);
  if (typeof value?.formula === "string") return value.result != null ? String(value.result) : `=${value.formula}`;
  return String(cell?.text || "");
}

async function loadWorkbook(arrayBuffer) {
  const ExcelJS = await ensureExcelJs();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(arrayBuffer.slice(0));
  return workbook;
}

function extractSheets(workbook) {
  return workbook.worksheets.map((worksheet) => {
    const maxColumns = worksheet.actualColumnCount || 0;
    const rowCount = worksheet.actualRowCount || 0;
    const headerRow = worksheet.getRow(1);
    const headers = Array.from({ length: maxColumns }, (_, index) => {
      const display = cellDisplayValue(headerRow.getCell(index + 1)).trim();
      return display || `column_${index + 1}`;
    });
    const rows = [];
    for (let rowNumber = 2; rowNumber <= rowCount; rowNumber += 1) {
      const row = worksheet.getRow(rowNumber);
      rows.push(Array.from({ length: maxColumns }, (_, index) => cellDisplayValue(row.getCell(index + 1))));
    }
    return {
      name: worksheet.name,
      headers,
      rows,
    };
  });
}

export async function prepareXlsxDocument(fileState) {
  const workbook = await loadWorkbook(fileState.arrayBuffer);
  const sheets = extractSheets(workbook);
  return {
    kind: "xlsx",
    name: fileState.name || "workbook.xlsx",
    sourceBytes: fileState.arrayBuffer.slice(0),
    sheets,
    formatInfo: {
      label: "Excel workbook (.xlsx)",
      guarantee: "Workbook structure, sheet names, rows, columns, and untouched cell formatting stay in place. Redacted cells are rewritten safely as plain values.",
    },
  };
}

export function scanXlsxDocument(document, options = {}) {
  const cells = [];
  document.sheets.forEach((sheet, sheetIndex) => {
    sheet.rows.forEach((row, rowIndex) => {
      row.forEach((cell, columnIndex) => {
        const header = sheet.headers[columnIndex] || `column_${columnIndex + 1}`;
        cells.push({
          value: cell,
          context: {
            kind: "xlsx",
            sheetIndex,
            rowIndex,
            columnIndex,
            keyHint: header,
            previewPath: `${sheet.name}!row ${rowIndex + 1}.${header}`,
          },
        });
      });
    });
  });
  const findings = scanValueCollectionWithIdentitySeeds(cells, options);
  const annotated = annotateFindings(findings);
  const previewLines = document.sheets.slice(0, 2).flatMap((sheet) => {
    const rows = [sheet.headers, ...sheet.rows].slice(0, 6);
    return [`[${sheet.name}]`, ...rows.map((row) => row.join("\t"))];
  });
  return {
    document,
    findings: annotated,
    summary: summarise(annotated),
    preview: previewLines.join("\n"),
    formatInfo: document.formatInfo,
  };
}

export async function redactXlsxDocument(scanResult, selectedIds, mode) {
  const selected = new Set(selectedIds);
  const cache = new Map();
  const workbook = await loadWorkbook(scanResult.document.sourceBytes);

  const grouped = new Map();
  for (const finding of scanResult.findings) {
    if (!selected.has(finding.id)) continue;
    const key = `${finding.context.sheetIndex}:${finding.context.rowIndex}:${finding.context.columnIndex}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(finding);
  }

  for (const [key, matches] of grouped.entries()) {
    const [sheetIndex, rowIndex, columnIndex] = key.split(":").map(Number);
    const worksheet = workbook.worksheets[sheetIndex];
    const cell = worksheet.getRow(rowIndex + 2).getCell(columnIndex + 1);
    let output = cellDisplayValue(cell);
    for (const finding of collapseOverlappingReplacements(matches, output, mode).sort(descendingReplacementOrder)) {
      const original = output.slice(finding.start, finding.end);
      const replacement = replacementFor(finding.label, original, mode, cache);
      output = `${output.slice(0, finding.start)}${replacement}${output.slice(finding.end)}`;
    }
    cell.value = output;
  }

  const binaryData = await workbook.xlsx.writeBuffer();
  const sheets = extractSheets(workbook);
  const previewLines = sheets.slice(0, 2).flatMap((sheet) => {
    const rows = [sheet.headers, ...sheet.rows].slice(0, 6);
    return [`[${sheet.name}]`, ...rows.map((row) => row.join("\t"))];
  });

  return {
    text: previewLines.join("\n"),
    binaryData,
    blobType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    fileName: scanResult.document.name.replace(/\.xlsx$/i, "") + "-redacted.xlsx",
    formatInfo: scanResult.formatInfo,
    copyable: false,
  };
}
