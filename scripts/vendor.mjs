import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modules = path.join(repoRoot, "node_modules");
const vendor = path.join(repoRoot, "static", "vendor");
// The .wasm.js cores embed their wasm, and every Baseline browser has wasm SIMD,
// so the standalone .wasm files and the non-SIMD core are never fetched.
const coreFiles = ["tesseract-core-simd-lstm.wasm.js", "tesseract-core-relaxedsimd-lstm.wasm.js"]
  .map((file) => [`tesseract.js-core/${file}`, `tesseract/core/${file}`]);

// Stale directories are wiped first so removed upstream files don't linger.
const clean = ["pdfjs/standard_fonts", "tesseract/core", "tesseract/lang"];

// [source under node_modules, destination under static/vendor]
const copies = [
  ["exceljs/dist/exceljs.min.js", "exceljs/exceljs.min.js"],
  ["mammoth/mammoth.browser.min.js", "mammoth/mammoth.browser.min.js"],
  ["pdf-lib/dist/pdf-lib.min.js", "pdflib/pdf-lib.min.js"],
  ["pdfjs-dist/build/pdf.min.mjs", "pdfjs/pdf.min.mjs"],
  ["pdfjs-dist/build/pdf.worker.min.mjs", "pdfjs/pdf.worker.min.mjs"],
  ["pdfjs-dist/standard_fonts", "pdfjs/standard_fonts"],
  ["tesseract.js/dist/tesseract.min.js", "tesseract/tesseract.min.js"],
  ["tesseract.js/dist/worker.min.js", "tesseract/worker.min.js"],
  ...coreFiles,
  ["@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", "tesseract/lang/eng.traineddata.gz"],
];

for (const dir of clean) {
  rmSync(path.join(vendor, dir), { recursive: true, force: true });
}

for (const [from, to] of copies) {
  const source = path.join(modules, from);
  const target = path.join(vendor, to);
  if (!existsSync(source)) {
    throw new Error(`Missing vendor asset: node_modules/${from}`);
  }
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
  console.log(`Copied static/vendor/${to}`);
}

await build({
  stdin: {
    contents: [
      'export { fromMarkdown } from "mdast-util-from-markdown";',
      'export { gfmTableFromMarkdown } from "mdast-util-gfm-table";',
      'export { gfmTable } from "micromark-extension-gfm-table";',
    ].join("\n"),
    resolveDir: repoRoot,
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  outfile: path.join(vendor, "markdown", "markdown-parser.bundle.mjs"),
  logLevel: "info",
});
