import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const vendorRoot = path.join(repoRoot, "static", "vendor", "tesseract");
const coreRoot = path.join(vendorRoot, "core");
const langRoot = path.join(vendorRoot, "lang");

const copies = [
  {
    from: path.join(repoRoot, "node_modules", "tesseract.js", "dist", "tesseract.min.js"),
    to: path.join(vendorRoot, "tesseract.min.js"),
  },
  {
    from: path.join(repoRoot, "node_modules", "tesseract.js", "dist", "worker.min.js"),
    to: path.join(vendorRoot, "worker.min.js"),
  },
  {
    from: path.join(repoRoot, "node_modules", "tesseract.js-core", "tesseract-core-lstm.wasm.js"),
    to: path.join(coreRoot, "tesseract-core-lstm.wasm.js"),
  },
  {
    from: path.join(repoRoot, "node_modules", "tesseract.js-core", "tesseract-core-lstm.wasm"),
    to: path.join(coreRoot, "tesseract-core-lstm.wasm"),
  },
  {
    from: path.join(repoRoot, "node_modules", "tesseract.js-core", "tesseract-core-simd-lstm.wasm.js"),
    to: path.join(coreRoot, "tesseract-core-simd-lstm.wasm.js"),
  },
  {
    from: path.join(repoRoot, "node_modules", "tesseract.js-core", "tesseract-core-simd-lstm.wasm"),
    to: path.join(coreRoot, "tesseract-core-simd-lstm.wasm"),
  },
  {
    from: path.join(repoRoot, "node_modules", "tesseract.js-core", "tesseract-core-relaxedsimd-lstm.wasm.js"),
    to: path.join(coreRoot, "tesseract-core-relaxedsimd-lstm.wasm.js"),
  },
  {
    from: path.join(repoRoot, "node_modules", "tesseract.js-core", "tesseract-core-relaxedsimd-lstm.wasm"),
    to: path.join(coreRoot, "tesseract-core-relaxedsimd-lstm.wasm"),
  },
  {
    from: path.join(repoRoot, "node_modules", "@tesseract.js-data", "eng", "4.0.0_best_int", "eng.traineddata.gz"),
    to: path.join(langRoot, "eng.traineddata.gz"),
  },
];

mkdirSync(vendorRoot, { recursive: true });
rmSync(coreRoot, { recursive: true, force: true });
rmSync(langRoot, { recursive: true, force: true });
mkdirSync(coreRoot, { recursive: true });
mkdirSync(langRoot, { recursive: true });

for (const entry of copies) {
  if (!existsSync(entry.from)) {
    throw new Error(`Missing OCR asset: ${path.relative(repoRoot, entry.from)}`);
  }
  cpSync(entry.from, entry.to);
  console.log(`Copied ${path.relative(repoRoot, entry.to)}`);
}

console.log("Local OCR assets are ready under static/vendor/tesseract.");
