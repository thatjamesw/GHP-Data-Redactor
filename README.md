# Redactor MVP

Browser-based redaction tool for cleaning sensitive data before sharing it with LLMs or other external systems.

## What It Does

- Scans pasted text or uploaded text-based files locally in the browser
- Flags likely PII and secrets such as emails, phone numbers, SSNs, tax IDs, passport-like IDs, driver's-license-like IDs, IPs, MAC addresses, VINs, street addresses, UUIDs, API keys, JWTs, and credit card numbers
- Uses identity-aware scanning for names, places, and organisations, including case-insensitive and light leetspeak variants once a confident seed has been found
- Offers an opt-in `Deep scan` that runs a local AI model (OpenAI Privacy Filter) in your browser to catch names, addresses, dates, and account numbers in ordinary sentences
- Lets you review findings before applying them
- Supports both `redact` and `pseudonymise` output modes
- Includes a one-click `LLM-safe copy` workflow
- Lets you copy the cleaned result or export it as a file
- Includes a built-in benchmark view so you can track detector coverage over time
- Includes workflow presets for `LLM-safe`, `Balanced`, `Secrets only`, and `Structured PII`
- Includes a more conservative `Paranoid redaction` preset
- Supports manual blackout boxes for image and PDF redaction when detection misses a region
- Includes a regression runner for overlap and structured-redaction edge cases
- Includes a one-click secure session wipe for clearing previews, worker state, and in-memory buffers

## Security Posture

- No backend processing
- No analytics, telemetry, or remote logging
- No browser storage used for your pasted data
- Strict client-side Content Security Policy via meta tag
- Referrer disabled
- Browser permissions locked down via `Permissions-Policy`
- No third-party runtime scripts
- OCR worker, core, and English language data served locally from this repo
- OCR traineddata cache disabled to avoid persisting language assets or OCR state in IndexedDB

This means the default GitHub Pages deployment is designed to avoid outbound network requests during both text and OCR workflows.

The one exception is the opt-in `Deep scan`:

- When enabled, the browser downloads the model weights (~840 MB, `openai/privacy-filter` pinned to a fixed revision) from Hugging Face once. The Content Security Policy allows `huggingface.co` and `*.hf.co` for this download only
- Only model files are fetched. Your text is never sent anywhere, and the model runtime (`transformers.js` and the ONNX WebAssembly runtime) is served from this repo
- The browser caches the model weights so later visits skip the download. No pasted data is cached, and `Secure wipe` also stops the model worker
- Deep scan needs WebGPU (current Chrome, Edge, or Safari). The option is disabled in other browsers

## Dependency Updates

The repository now includes:

- `package.json` for managed OCR dependency tracking
- `.github/dependabot.yml` for weekly updates to both npm dependencies and GitHub Actions

For browser parsing specifically, Dependabot can keep `tesseract.js`, `@tesseract.js-data/eng`, `exceljs`, `pdfjs-dist`, `pdf-lib`, and `@huggingface/transformers` current. That is much safer and more maintainable than hardcoding third-party CDN scripts in the page.
It can also keep `mammoth` current for local DOCX text extraction.

## Supported Inputs

The static build currently supports:

- pasted text
- `.txt`
- `.csv`
- `.tsv`
- `.json`
- `.yaml`
- `.yml`
- `.md` and pasted markdown
- `.xlsx`
- `.pdf`
- `.docx`
- `.png`, `.jpg`, `.jpeg`, `.webp`, and other browser-readable images via local OCR

## Detection Approach

The scanner is split into recognizer-style layers so we can improve coverage without turning the codebase into one large regex file:

- `structured` detectors handle high-shape values such as emails, IPs, cards, UUIDs, secrets, IDs, and addresses
- `identity` detectors handle people, places, and organisations using contextual cues, semantic field hints, and seeded propagation
- `shared` helpers centralize confidence boosts, category handling, and match bookkeeping
- format scanners for text, markdown, CSV, TSV, JSON, YAML, XLSX, PDF, DOCX, and images provide document-specific context without owning the detection rules themselves

Some important behavior:

- Markdown headers are treated as semantic hints only when they describe sensitive fields such as name, email, city, or country
- Headers themselves are not redacted unless they are actual findings
- Identity propagation is seeded from higher-confidence findings first, then reused to catch nearby variants like `James`, `jAmEs`, or `j4m3s`
- Weak structured patterns are boosted by context instead of automatically trusted
- Pasted input is biased toward plain-text scanning unless the structured shape is clearly stronger
- Ambiguous pasted input can still fall back to CSV, TSV, or YAML scanning when that materially improves coverage

This keeps the browser build explainable and testable while avoiding overly broad fuzzy matching.

## Format Guarantees

- `Text`: whitespace and line breaks are preserved except where matched values are replaced
- `JSON`: structure and surrounding whitespace are preserved while string scalar values are updated in place
- `CSV` / `TSV`: row and column shape are preserved, though field quoting may be normalized on export
- `XLSX`: workbook structure, sheet names, and row/column layout are preserved; untouched formatting stays in place, while redacted cells are safely rewritten as plain values
- `YAML`: inline scalar values are updated while surrounding formatting is preserved for standard mappings and lists; advanced YAML features such as complex tags, anchors, and block scalar bodies are intentionally left untouched
- `PDF`: pages are rendered locally, detected regions are covered with black bars, and export produces a flattened redacted PDF
- `DOCX`: document text is extracted locally and exported as cleaned text; original DOCX layout and styling are not rewritten yet

## Current Gaps

These are not yet part of the static browser build:

- editable native PDF redaction annotations
- exact byte-for-byte formatting preservation for every structured format

## Local OCR Assets

OCR is now bundled locally for a security-first static deployment. The app loads only from:

- `static/vendor/tesseract/tesseract.min.js`
- `static/vendor/tesseract/worker.min.js`
- `static/vendor/tesseract/core`
- `static/vendor/tesseract/lang`
- `static/vendor/exceljs/exceljs.min.js`
- `static/vendor/pdfjs/pdf.min.mjs`
- `static/vendor/pdfjs/pdf.worker.min.mjs`
- `static/vendor/pdflib/pdf-lib.min.js`
- `static/vendor/mammoth/mammoth.browser.min.js`

The vendored files are generated from npm dependencies with:

```bash
npm install
npm run vendor:browser-deps
```

That script copies the OCR runtime, worker, WebAssembly core files, `eng.traineddata.gz`, the local Excel workbook bundle, the local PDF parsing bundle, the local PDF assembly bundle, and the local DOCX extraction bundle from managed dependencies into the static site directory.

Current OCR scope:

- English language OCR only
- black-box image redaction export
- no OCR blob worker URLs
- no IndexedDB OCR cache writes

## Safety Workflow

For high-risk use:

- choose `Paranoid redaction`
- review the residual-risk banner before copy/export
- for images or PDFs, add manual blackout boxes if detection misses a face, signature, field, or region
- use `Secure wipe` when you are done and want the app to clear file buffers, generated previews, and local OCR state as aggressively as the browser allows

The output panel now warns when findings remain outside the current output, so the app makes residual risk more visible before handoff.

## Regression Checks

Run the local regression suite with:

```bash
npm run test:regress
```

This covers the structured-redaction and overlap bugs we already hit, including:

- full international email redaction
- no partial leftovers like `[REDACTED].cn`
- JSON/YAML/CSV shape-preserving redaction paths
- ambiguous pasted content classification
- markdown tables and header-driven semantic hints
- identity seed propagation across case and leetspeak variants
- `.xlsx` and `.pdf` regression coverage

## CI Guardrails

GitHub Actions now runs a lightweight CI workflow on pushes to `main` and on pull requests:

- `npm ci`
- `npm audit --audit-level=high`
- `npm run vendor:browser-deps`
- `npm run test:regress`

That gives the repo an automated check for dependency health and the regressions we have already fixed.

Current audit status:

- `npm audit --audit-level=high` is clean
- a moderate advisory remains through `exceljs -> uuid`
- the npm-proposed fix downgrades `exceljs` to a breaking version, so it should be handled deliberately rather than with `npm audit fix --force`

## GitHub Pages

This repo is set up to deploy as a static site with GitHub Pages via GitHub Actions.

Once Pages is enabled for the repository, pushes to `main` will publish the app automatically.

The Pages workflow installs locked npm dependencies and regenerates the local OCR bundle before uploading the site artifact, so Dependabot updates flow through deployment cleanly.

It now regenerates all local browser bundles, including OCR, XLSX, and PDF parsing assets.

## Local Development

Because this is now a static app, the easiest way to test it locally is with a simple static server:

```bash
cd /Users/jameswright/dev/_mvp/GHP-Data-Redactor
python3 -m http.server 4173
```

Then open:

```text
http://localhost:4173
```

Using a local server is more reliable than opening `index.html` directly from `file://`, because the app uses ES modules.
