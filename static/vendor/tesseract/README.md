Local OCR assets live here so image redaction can work without any CDN or backend.

Generated files:

- `static/vendor/tesseract/tesseract.min.js`
- `static/vendor/tesseract/worker.min.js`
- `static/vendor/tesseract/core/*-lstm.*`
- `static/vendor/tesseract/lang/eng.traineddata.gz`

Refresh these files after dependency updates with:

```bash
npm install
npm run vendor:ocr
```

Why this folder exists:

- the app intentionally avoids third-party runtime script loads
- OCR is configured to use local worker, core, and language assets only
- the OCR cache is disabled so traineddata is not persisted in browser storage
- the app uses Tesseract's LSTM-only OCR mode, so only LSTM-capable core variants are vendored
