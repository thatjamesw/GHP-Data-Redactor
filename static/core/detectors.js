import { dedupeFindings } from "./utils.js";
import { addFinding, categoryEnabled } from "./detection/shared.js";
import { scanIdentityFindings } from "./detection/identity.js";
import { scanStructuredFindings } from "./detection/structured.js";

// Deep-scan entities run before identity scanning so model-found names seed variant propagation.
function scanModelEntityFindings(content, options, context, findings) {
  for (const { label, text, score } of options.modelEntities || []) {
    if (!categoryEnabled(options, label)) continue;
    for (let start = content.indexOf(text); start !== -1; start = content.indexOf(text, start + text.length)) {
      const end = start + text.length;
      if (findings.some((item) => item.start <= start && item.end >= end)) continue;
      addFinding(findings, label, Math.min(0.92, score), start, end, text, ["deep_scan_model"], context);
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
