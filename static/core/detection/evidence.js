import { normalizeIdentityText } from "../utils.js";

const FIELD_ALIASES = {
  EMAIL: ["email", "e mail", "mail"],
  PHONE: ["phone", "telephone", "tel", "mobile", "cell", "fax", "contact number"],
  SSN: ["ssn", "social security"],
  US_TAX_ID: ["tax id", "tin", "itin", "ein", "vat"],
  VAT_ID: ["vat", "vat id", "tax id", "mva", "tva", "cif", "nif", "nie", "ust idnr"],
  IBAN: ["iban", "account", "bank account"],
  BIC: ["bic", "swift", "swift code"],
  PASSPORT: ["passport", "passport number"],
  DRIVERS_LICENSE: ["driver license", "drivers license", "licence", "license number"],
  VIN: ["vin", "vehicle identification", "vehicle id"],
  MAC_ADDRESS: ["mac", "mac address"],
  CREDIT_CARD: ["card", "credit card", "debit card", "payment", "cc", "pan"],
  PERSON: ["name", "full name", "first name", "last name", "contact", "author", "person", "customer", "client", "employee", "user", "owner", "recipient"],
  PLACE: ["city", "town", "location", "country", "region", "place"],
  ORG: ["company", "organisation", "organization", "employer", "business", "tenant", "org"],
  STREET_ADDRESS: ["address", "addr", "street", "route"],
  POTENTIAL_SECRET: ["secret", "token", "key", "credential", "password", "api key"],
};

const GENERIC_SENSITIVE_TOKENS = new Set(["id", "identifier", "number", "num", "no", "nr", "code", "value"]);
const IDENTITY_CONTEXT_BLOCKLIST = new Set([
  "alert", "alert family", "capability", "change", "channel", "component", "definition", "description", "dr field",
  "environment", "escalate", "field", "frequency", "impact", "method", "mitigation", "note", "notes", "purpose",
  "retention", "risk", "role", "severity", "status", "system", "title", "trigger", "type", "use", "version",
]);
const ADDRESS_TOKEN = /[\p{Script=Latin}\p{M}0-9.'\u2019/-]+/gu;
const POSTAL_CODE = /\b(?:[A-Z]{1,2}[-\s]?)?\d{3,6}(?:[-\s]\d{2,4})?\b/i;
// "221B Baker Street": a house number followed by capitalised words ending in an English street type.
const NUMBERED_STREET = /\b\d{1,6}[A-Za-z]?\s+(?:\p{Lu}[\p{L}\p{M}'\u2019-]*\s+){1,3}(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Boulevard|Blvd|Way|Parkway|Pkwy|Place|Pl|Court|Ct|Terrace|Close|Crescent|Square|Highway|Hwy)\b/u;
// "Ship to 221B Baker Street": up to three lead-in words ending in a preposition are not part of the address.
const ADDRESS_LEAD_IN = /^(?:\S+\s+){0,3}?(?:to|at|from|is|in)\s+/i;
const OBVIOUS_NON_ADDRESS = /\b(?:iban|bic|swift|vat|version|build|invoice|order|project|issue|ticket|room|page|section|chapter|row|column)\b/i;
const DATE_LIKE = /\b(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})\b/;
const EMAIL_VALUE = /^[A-Za-z0-9._%+\-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$/;
const PHONE_VALUE = /^[+\d(][\d\s().-]{6,}$/;
const CREDIT_CARD_VALUE = /^(?:\d[ -]*?){13,19}$/;
const IBAN_VALUE = /^[A-Z]{2}\d{2}[A-Z0-9](?: ?[A-Z0-9]){10,30}$/;
const BIC_VALUE = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/;
const VAT_VALUE = /^(?:ATU\d{8}|BE0?\d{9}|DE\d{9}|DK\d{8}|ES[A-Z0-9]\d{7}[A-Z0-9]|FI\d{8}|FR[A-Z0-9]{2}\d{9}|GB(?:\d{9}|\d{12}|GD\d{3}|HA\d{3})|IE\d[A-Z0-9]\d{5}[A-Z]|IT\d{11}|NL\d{9}B\d{2}|NO\d{9}MVA|PL\d{10}|PT\d{9}|SE\d{12})$/;
const IPV4_VALUE = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)$/;
const IPV4_CIDR_VALUE = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\/(?:[0-9]|[12][0-9]|3[0-2])$/;
const IPV6_VALUE = /^(?:[A-F0-9]{1,4}:){7}[A-F0-9]{1,4}$/i;
const MAC_VALUE = /^(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;
const VIN_VALUE = /^[A-HJ-NPR-Z0-9]{17}$/;
const SECRET_VALUE = /^[A-Za-z0-9_\-]{24,}$/;
const PASSPORT_VALUE = /^(?=.*[A-Z])(?=.*\d)[A-Z0-9-]{6,12}$/;
const LICENSE_VALUE = /^[A-Z0-9-]{6,16}$/;
const TAX_VALUE = /^[A-Z0-9-]{8,15}$/;
const PERSON_VALUE = /^[\p{Script=Latin}\p{M}][\p{Script=Latin}\p{M} ,.'\u2019-]{1,60}$/u;
const ORG_VALUE = /^(?=.*\p{Script=Latin})[\p{Script=Latin}\p{M}0-9][\p{Script=Latin}\p{M}0-9 &.,'\u2019-]{2,80}$/u;

function contextSegments(context = {}) {
  return [
    context.keyHint,
    context.previewPath,
    context.path,
    context.kind,
  ]
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter(Boolean)
    .map((value) => normalizeIdentityText(String(value).replace(/([a-z])([A-Z])/g, "$1 $2")))
    .filter(Boolean);
}

function aliasMatched(segments, label) {
  const aliases = FIELD_ALIASES[label] || [];
  if (!aliases.length || !segments.length) return false;
  const joined = segments.join(" ");
  const segmentTokenSets = segments.map((segment) => new Set(segment.split(" ").filter(Boolean)));
  return aliases.some((alias) => {
    const normalizedAlias = normalizeIdentityText(alias);
    if (!normalizedAlias) return false;
    if (joined.includes(normalizedAlias)) return true;
    const aliasTokens = normalizedAlias.split(" ").filter(Boolean);
    return segmentTokenSets.some((tokens) => aliasTokens.every((token) => tokens.has(token)));
  });
}

function identityContextBlocked(segments) {
  return segments.some((segment) => segment.split(" ").some((token) => IDENTITY_CONTEXT_BLOCKLIST.has(token)));
}

export function semanticEvidence(context = {}, label) {
  let score = 0;
  const reasons = [];
  const segments = contextSegments(context);
  if (["PERSON", "PLACE", "ORG"].includes(label) && identityContextBlocked(segments)) {
    return { matched: false, score: 0, reasons: ["identity_context_blocked"] };
  }
  if (Array.isArray(context.profileHints) && context.profileHints.includes(label)) {
    score += 0.18;
    reasons.push("profile_hint");
  }
  if (aliasMatched(segments, label)) {
    score += 0.16;
    reasons.push("field_alias");
  }
  if (segments.some((segment) => segment.split(" ").some((token) => GENERIC_SENSITIVE_TOKENS.has(token)))) {
    score += 0.04;
    reasons.push("generic_sensitive_key");
  }
  return { matched: score > 0, score: Math.min(score, 0.24), reasons };
}

export function confidenceWithEvidence(baseConfidence, context, label, ceiling = 0.99) {
  const evidence = semanticEvidence(context, label);
  return Math.min(ceiling, baseConfidence + evidence.score);
}

export function isLikelyStreetAddress(value) {
  const trimmed = String(value ?? "").trim();
  if (trimmed.length < 5 || trimmed.length > 160) return false;
  if (!/\d/.test(trimmed) || !/\p{Script=Latin}/u.test(trimmed)) return false;
  if (OBVIOUS_NON_ADDRESS.test(trimmed) || DATE_LIKE.test(trimmed)) return false;
  if (EMAIL_VALUE.test(trimmed) || PHONE_VALUE.test(trimmed) || IPV4_VALUE.test(trimmed) || IPV4_CIDR_VALUE.test(trimmed)) return false;

  const tokens = [...trimmed.matchAll(ADDRESS_TOKEN)].map((match) => match[0]);
  if (tokens.length < 2 || tokens.length > 10) return false;
  const numberIndexes = [];
  let numericLikeCount = 0;
  tokens.forEach((token, index) => {
    if (/\d/.test(token)) numericLikeCount += 1;
    if (/^\d{1,6}[A-Za-z]?(?:[-/]\d+[A-Za-z]?)?$/.test(token)) numberIndexes.push(index);
  });
  if (!numberIndexes.length || numericLikeCount > 2) return false;

  const latinIndexes = tokens
    .map((token, index) => (/^\p{Script=Latin}[\p{Script=Latin}\p{M}.'\u2019-]{1,}$/u.test(token) ? index : -1))
    .filter((index) => index !== -1);
  if (!latinIndexes.length) return false;

  return numberIndexes.some((numberIndex) => latinIndexes.some((latinIndex) => Math.abs(latinIndex - numberIndex) <= 5));
}

export function addressCandidates(content) {
  const candidates = [];
  const lines = String(content ?? "").split(/\r?\n/);
  let offset = 0;
  for (const line of lines) {
    const rawParts = line.includes(":") ? [line.slice(line.indexOf(":") + 1), line] : [line];
    for (const rawPart of rawParts) {
      const whole = rawPart.trim();
      const withoutLeadIn = whole.replace(ADDRESS_LEAD_IN, "");
      const value = withoutLeadIn !== whole && isLikelyStreetAddress(withoutLeadIn) ? withoutLeadIn : whole;
      if (!isLikelyStreetAddress(value)) continue;
      const start = offset + line.indexOf(value);
      candidates.push({ value, start, end: start + value.length });
      break;
    }
    offset += line.length + 1;
  }
  return candidates;
}

export function addressConfidence(value, context = {}) {
  let confidence = isLikelyStreetAddress(value) ? 0.72 : 0;
  if (POSTAL_CODE.test(value)) confidence += 0.06;
  if (NUMBERED_STREET.test(value)) confidence += 0.1;
  confidence += semanticEvidence(context, "STREET_ADDRESS").score;
  return Math.min(0.9, confidence);
}

export function valueShapeLabels(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return [];
  const labels = [];
  if (EMAIL_VALUE.test(trimmed)) labels.push("EMAIL");
  if (PHONE_VALUE.test(trimmed) && !DATE_LIKE.test(trimmed) && trimmed.replace(/\D/g, "").length >= 7 && trimmed.replace(/\D/g, "").length <= 15) labels.push("PHONE");
  if (CREDIT_CARD_VALUE.test(trimmed)) labels.push("CREDIT_CARD");
  if (IBAN_VALUE.test(trimmed.replace(/\s+/g, " ").toUpperCase())) labels.push("IBAN");
  if (BIC_VALUE.test(trimmed.toUpperCase())) labels.push("BIC");
  if (VAT_VALUE.test(trimmed.replace(/[\s.-]/g, "").toUpperCase())) labels.push("VAT_ID");
  if (IPV4_CIDR_VALUE.test(trimmed)) labels.push("IPV4_CIDR");
  else if (IPV4_VALUE.test(trimmed)) labels.push("IPV4");
  if (IPV6_VALUE.test(trimmed)) labels.push("IPV6");
  if (MAC_VALUE.test(trimmed)) labels.push("MAC_ADDRESS");
  if (VIN_VALUE.test(trimmed)) labels.push("VIN");
  if (PASSPORT_VALUE.test(trimmed)) labels.push("PASSPORT");
  if (LICENSE_VALUE.test(trimmed)) labels.push("DRIVERS_LICENSE");
  if (TAX_VALUE.test(trimmed)) labels.push("US_TAX_ID");
  if (SECRET_VALUE.test(trimmed)) labels.push("POTENTIAL_SECRET");
  if (isLikelyStreetAddress(trimmed)) labels.push("STREET_ADDRESS");
  if (!DATE_LIKE.test(trimmed) && PERSON_VALUE.test(trimmed) && trimmed.split(/\s+/).length >= 2) labels.push("PERSON");
  if (!DATE_LIKE.test(trimmed) && PERSON_VALUE.test(trimmed)) labels.push("PLACE");
  if (!DATE_LIKE.test(trimmed) && ORG_VALUE.test(trimmed)) labels.push("ORG");
  return labels;
}
