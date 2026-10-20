import fs from "node:fs";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";

import { applyTextReplacements, prepareDocument, redactDocument, scanDocument } from "../static/redactor-core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const casesPath = path.join(repoRoot, "tests", "regression-cases.json");
const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));

function optionsFor(testCase) {
  return {
    strictEmail: testCase.options?.strictEmail ?? true,
    detectNames: testCase.options?.detectNames ?? true,
    modelEntities: testCase.options?.modelEntities,
    detectFaces: false,
    aggressiveImageDocs: false,
    imageMode: "standard",
    enabledCategories: testCase.options?.enabledCategories ?? {
      pii: true,
      identity: true,
      financial: true,
      network: true,
      secrets: true,
    },
  };
}

async function runCase(testCase) {
  const document = await prepareDocument({
    textInput: testCase.input,
    fileName: testCase.fileName,
    fileMeta: null,
  });
  const scan = await scanDocument(document, optionsFor(testCase));
  const threshold = testCase.threshold === "medium" ? 0.55 : 0.8;
  const selected = scan.findings.filter((finding) => finding.confidence >= threshold).map((finding) => finding.id);
  const redacted = await redactDocument(scan, selected, testCase.mode || "redact");
  const output = redacted.text || "";

  const failures = [];
  for (const present of testCase.expectPresent || []) {
    if (!output.includes(present)) failures.push(`missing expected text: ${present}`);
  }
  for (const absent of testCase.expectAbsent || []) {
    if (output.includes(absent)) failures.push(`unexpected residual text: ${absent}`);
  }
  if (typeof testCase.minFindings === "number" && scan.summary.total < testCase.minFindings) {
    failures.push(`expected at least ${testCase.minFindings} findings, got ${scan.summary.total}`);
  }
  if (typeof testCase.maxFindings === "number" && scan.summary.total > testCase.maxFindings) {
    failures.push(`expected at most ${testCase.maxFindings} findings, got ${scan.summary.total}`);
  }

  return { name: testCase.name, failures };
}

function buildMinimalPdf(text) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length + 31} >>\nstream\nBT\n/F1 18 Tf\n24 96 Td\n(${text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")}) Tj\nET\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = body.length;
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  offsets.slice(1).forEach((offset) => {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  body += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new TextEncoder().encode(body).buffer;
}

// A one-entry deflated zip holding word/document.xml is all the DOCX reader needs.
function buildMinimalDocx(paragraphs) {
  const xml = Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${
    paragraphs.map((text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`).join("")
  }</w:body></w:document>`);
  const name = Buffer.from("word/document.xml");
  const data = deflateRawSync(xml);
  const entry = (signature, size) => {
    const header = Buffer.alloc(size);
    header.writeUInt32LE(signature, 0);
    return header;
  };
  const local = entry(0x04034b50, 30);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(xml), 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(xml.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = entry(0x02014b50, 46);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(xml), 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(xml.length, 24);
  central.writeUInt16LE(name.length, 28);
  const centralOffset = local.length + name.length + data.length;
  const end = entry(0x06054b50, 22);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  const bytes = Buffer.concat([local, name, data, central, name, end]);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function runGeneratedCases() {
  const generated = [];

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("People");
  sheet.addRow(["email", "phone", "notes"]);
  sheet.addRow(["alice@example.com", "+1 (415) 555-0199", "keep structure"]);
  const workbookBytes = await workbook.xlsx.writeBuffer();
  generated.push({
    name: "xlsx redacts structured workbook cells",
    documentArgs: {
      textInput: "",
      fileName: "sample.xlsx",
      fileMeta: { kind: "xlsx", name: "sample.xlsx", arrayBuffer: workbookBytes },
    },
    expectAbsent: ["alice@example.com", "555-0199"],
    expectPresent: ["[REDACTED]"],
    minFindings: 2,
  });

  generated.push({
    name: "pdf extracts and redacts text pages",
    documentArgs: {
      textInput: "",
      fileName: "sample.pdf",
      fileMeta: { kind: "pdf", name: "sample.pdf", arrayBuffer: buildMinimalPdf("John Doe john@example.com") },
    },
    expectAbsent: ["john@example.com"],
    expectPresent: ["[REDACTED]"],
    minFindings: 1,
  });

  generated.push({
    name: "docx extracts paragraph text and redacts it",
    documentArgs: {
      textInput: "",
      fileName: "sample.docx",
      fileMeta: { kind: "docx", name: "sample.docx", arrayBuffer: buildMinimalDocx(["Contact: Tom &amp; Jerry", "Email anna.berg@example.com"]) },
    },
    expectAbsent: ["anna.berg@example.com"],
    expectPresent: ["Tom & Jerry", "[REDACTED]"],
    minFindings: 1,
  });

  const results = [];
  for (const testCase of generated) {
    const document = await prepareDocument(testCase.documentArgs);
    const scan = await scanDocument(document, optionsFor(testCase));
    const selected = scan.findings.filter((finding) => finding.confidence >= 0.55).map((finding) => finding.id);
    const redacted = await redactDocument(scan, selected, "redact");
    const output = redacted.text || "";
    const failures = [];
    for (const present of testCase.expectPresent || []) {
      if (!output.includes(present)) failures.push(`missing expected text: ${present}`);
    }
    for (const absent of testCase.expectAbsent || []) {
      if (output.includes(absent)) failures.push(`unexpected residual text: ${absent}`);
    }
    if (typeof testCase.minFindings === "number" && scan.summary.total < testCase.minFindings) {
      failures.push(`expected at least ${testCase.minFindings} findings, got ${scan.summary.total}`);
    }
    results.push({ name: testCase.name, failures });
  }

  return results;
}

function runReplacementCases() {
  const overlapOutput = applyTextReplacements("name: James Wright", [
    { id: "short", label: "PERSON", confidence: 0.63, start: 6, end: 11, original: "James", reasoning: [] },
    { id: "long", label: "PERSON", confidence: 0.84, start: 6, end: 18, original: "James Wright", reasoning: [] },
  ], new Set(["short", "long"]), "redact");

  return [{
    name: "overlapping findings collapse before redaction",
    failures: overlapOutput === "name: [REDACTED]" ? [] : [`expected collapsed redaction, got: ${overlapOutput}`],
  }];
}

const results = [];
for (const testCase of cases) {
  // eslint-disable-next-line no-await-in-loop
  results.push(await runCase(testCase));
}
results.push(...(await runGeneratedCases()));
results.push(...runReplacementCases());

const failed = results.filter((result) => result.failures.length > 0);
for (const result of results) {
  const status = result.failures.length ? "FAIL" : "PASS";
  console.log(`${status} ${result.name}`);
  for (const failure of result.failures) console.log(`  - ${failure}`);
}

if (failed.length) {
  console.error(`\n${failed.length} regression case(s) failed.`);
  process.exit(1);
}

console.log(`\nAll ${results.length} regression cases passed.`);
