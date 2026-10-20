
export function luhnOk(value) {
  const digits = (value || "").replace(/\D/g, "");
  if (!digits) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

export function categoryForLabel(label) {
  if (["API_KEY", "AWS_ACCESS_KEY", "JWT", "POTENTIAL_SECRET"].includes(label)) return "secrets";
  if (["IPV4", "IPV4_CIDR", "IPV6", "MAC_ADDRESS"].includes(label)) return "network";
  if (["ACCOUNT_NUMBER", "BIC", "CREDIT_CARD", "IBAN", "US_TAX_ID", "VAT_ID"].includes(label)) return "financial";
  if (["PERSON", "PLACE", "ORG", "STREET_ADDRESS", "FACE", "DOCUMENT_TEXT"].includes(label)) return "identity";
  if (["PHONE", "EMAIL", "SSN", "PASSPORT", "PASSPORT_ZONE", "DRIVERS_LICENSE", "VIN", "UUID", "DATE", "URL"].includes(label)) return "pii";
  return "other";
}

export function categoryEnabled(options, label) {
  const category = categoryForLabel(label);
  const enabled = options.enabledCategories || {};
  return enabled[category] !== false;
}

export function addFinding(findings, label, confidence, start, end, original, reasoning, context) {
  findings.push({
    id: `f-${findings.length + 1}`,
    label,
    category: categoryForLabel(label),
    confidence,
    start,
    end,
    original,
    reasoning,
    context,
  });
}

export function contextContains(context = {}, pattern) {
  if (!pattern) return false;
  const haystack = [
    context.keyHint,
    context.previewPath,
    context.path,
    context.kind,
  ]
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter(Boolean)
    .join(" ");
  return pattern.test(haystack);
}

export function boostConfidence(baseConfidence, contextMatched, boost = 0.12, ceiling = 0.99) {
  if (!contextMatched) return baseConfidence;
  return Math.min(ceiling, baseConfidence + boost);
}

export function scanMatches(text, regex, label, baseConfidence, findings, context = {}, reasoning = ["pattern_match"]) {
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    addFinding(findings, label, baseConfidence, match.index, match.index + match[0].length, match[0], reasoning, context);
  }
}
