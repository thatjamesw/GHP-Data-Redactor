import { dedupeFindings } from "./utils.js";
import { addFinding, categoryEnabled } from "./detection/shared.js";
import { scanIdentityFindings } from "./detection/identity.js";
import { scanStructuredFindings } from "./detection/structured.js";

const WORD_CHAR = /[\p{L}\p{N}]/u;

// Deep-scan entities run before identity scanning so model-found names seed variant propagation.
// Matches must stand alone ("Mo" never inside "Monday"). A covering finding hides one only if it has the
// same label or is at least as confident, so a weak false match cannot block a strong model finding.
function scanModelEntityFindings(content, options, context, findings) {
  for (const { label, text, score } of options.modelEntities || []) {
    if (!categoryEnabled(options, label)) continue;
    const confidence = Math.min(0.92, score);
    for (let start = content.indexOf(text); start !== -1; start = content.indexOf(text, start + 1)) {
      const end = start + text.length;
      if (WORD_CHAR.test(content[start - 1] ?? "") || WORD_CHAR.test(content[end] ?? "")) continue;
      if (findings.some((item) => item.start <= start && item.end >= end && (item.label === label || item.confidence >= confidence))) continue;
      addFinding(findings, label, confidence, start, end, text, ["deep_scan_model"], context);
    }
  }
}

export function scanTextValue(text, options = {}, context = {}) {
  const content = String(text ?? "");
  const findings = [];

  scanStructuredFindings(content, options, context, findings);
  scanModelEntityFindings(content, options, context, findings);
  scanIdentityFindings(content, options, context, findings);

  findings.sort((left, right) => left.start - right.start || right.end - left.end);
  return dedupeFindings(findings);
}
