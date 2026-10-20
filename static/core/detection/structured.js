import { addressCandidates, addressConfidence, confidenceWithEvidence, isLikelyStreetAddress, semanticEvidence } from "./evidence.js";
import { addFinding, boostConfidence, categoryEnabled, contextContains, luhnOk, scanMatches } from "./shared.js";

const EMAIL_STRICT = /\b[A-Za-z0-9._%+\-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63}\b/g;
const EMAIL_LOOSE = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,63}\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b/g;
const IPV4_CIDR = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\/(?:[0-9]|[12][0-9]|3[0-2])\b/g;
const IPV6 = /\b(?:[A-F0-9]{1,4}:){7}[A-F0-9]{1,4}\b/gi;
const API_KEY = /\bsk-[A-Za-z0-9]{8,}\b/g;
const AWS_AKID = /\bAKIA[0-9A-Z]{16}\b/g;
const JWT = /\beyJ[0-9A-Za-z_\-]+\.[0-9A-Za-z_\-]+\.[0-9A-Za-z_\-]+\b/g;
const URL = /https?:\/\/[^\s`|<>)]+/g;
const GENERIC_SECRET = /\b[A-Za-z0-9_\-]{24,}\b/g;
const CREDIT_CARD = /\b(?:\d[ -]*?){13,19}\b/g;
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/gi;
const BIC = /\b[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/g;
const VAT_ID = /\b(?:ATU\d{8}|BE0?\d{9}|DE\d{9}|DK\d{8}|ES[A-Z0-9]\d{7}[A-Z0-9]|FI\d{8}|FR[A-Z0-9]{2}\d{9}|GB(?:\d{9}|\d{12}|GD\d{3}|HA\d{3})|IE\d[A-Z0-9]\d{5}[A-Z]|IT\d{11}|NL\d{9}B\d{2}|NO\d{9}MVA|PL\d{10}|PT\d{9}|SE\d{12})\b/gi;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const US_TIN = /\b9\d{2}-?(?:7\d|8[0-8]|9[0-2])-\d{4}\b/g;
const MAC_ADDRESS = /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g;
const VIN = /\b[A-HJ-NPR-Z0-9]{17}\b/g;
const PASSPORT_GENERIC = /\b[A-Z0-9]{6,9}\b/g;
const MRZ_PASSPORT_NUMBER = /\b[A-Z][0-9]{6,8}\b/g;
const MRZ_LINE = /\bP<[A-Z<]{10,}|\b[A-Z0-9<]{20,}\b/g;
const DRIVERS_LICENSE_GENERIC = /\b[A-Z]{1,2}\d{6,8}\b/g;
// A leading + or ( sits before the \b word boundary, so each gets its own start alternative.
const PHONE = /(?:(?<![+\d])\+\d{1,3}[\s.-]?|(?<!\()(?=\()|\b(?:\d{1,3}[\s.-]?)?)(?:\(?\d{2,4}\)?[\s.-]?)\d{3,4}[\s.-]?\d{3,4}\b/g;
const DATE_LIKE = /\b(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})\b/;
const PASSPORT_DISALLOWED = /^(?:true|false|null)$/i;
const VIN_DISALLOWED = /[IOQ]/;

function ibanChecksumOk(value) {
  const compact = String(value || "").replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
  const rearranged = `${compact.slice(4)}${compact.slice(0, 4)}`;
  let remainder = 0;
  for (const char of rearranged) {
    const expanded = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of expanded) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

function overlapsFinding(findings, start, end, labels) {
  return findings.some((finding) => labels.includes(finding.label) && start >= finding.start && end <= finding.end);
}

function scanUrlSecrets(content, context, findings) {
  URL.lastIndex = 0;
  let urlMatch;
  while ((urlMatch = URL.exec(content)) !== null) {
    const url = urlMatch[0];
    if (!/\/(?:api|events|hooks|webhook|v\d+)\//i.test(url)) continue;
    const tokenMatch = /(?:^|[/?#&=:-])([A-Za-z0-9_-]{32,})(?=$|[/?#&.=:-])/.exec(url);
    if (!tokenMatch) continue;
    const delimiterOffset = tokenMatch[0].indexOf(tokenMatch[1]);
    const start = urlMatch.index + tokenMatch.index + delimiterOffset;
    addFinding(findings, "POTENTIAL_SECRET", 0.88, start, start + tokenMatch[1].length, tokenMatch[1], ["api_url_token"], context);
  }
}

export function scanStructuredFindings(content, options = {}, context = {}, findings = []) {
  const emailContext = semanticEvidence(context, "EMAIL").matched;
  const phoneContext = semanticEvidence(context, "PHONE").matched;
  const taxIdContext = semanticEvidence(context, "US_TAX_ID").matched;
  const passportContext = semanticEvidence(context, "PASSPORT").matched;
  const licenseContext = semanticEvidence(context, "DRIVERS_LICENSE").matched;
  const vinContext = semanticEvidence(context, "VIN").matched;
  const macContext = semanticEvidence(context, "MAC_ADDRESS").matched;

  if (categoryEnabled(options, "EMAIL")) {
    const emailRegex = emailContext ? EMAIL_LOOSE : (options.strictEmail ? EMAIL_STRICT : EMAIL_LOOSE);
    const emailConfidence = confidenceWithEvidence(options.strictEmail ? 0.91 : 0.82, context, "EMAIL");
    scanMatches(content, emailRegex, "EMAIL", emailConfidence, findings, context);
  }
  if (categoryEnabled(options, "API_KEY")) scanMatches(content, API_KEY, "API_KEY", 0.96, findings, context);
  if (categoryEnabled(options, "AWS_ACCESS_KEY")) scanMatches(content, AWS_AKID, "AWS_ACCESS_KEY", 0.95, findings, context);
  if (categoryEnabled(options, "JWT")) scanMatches(content, JWT, "JWT", 0.92, findings, context);
  if (categoryEnabled(options, "UUID")) scanMatches(content, UUID, "UUID", 0.87, findings, context);
  if (categoryEnabled(options, "IPV4_CIDR")) scanMatches(content, IPV4_CIDR, "IPV4_CIDR", 0.94, findings, context);
  if (categoryEnabled(options, "IPV4")) scanMatches(content, IPV4, "IPV4", 0.82, findings, context);
  if (categoryEnabled(options, "IPV6")) scanMatches(content, IPV6, "IPV6", 0.82, findings, context);
  if (categoryEnabled(options, "SSN")) scanMatches(content, SSN, "SSN", 0.95, findings, context);
  if (categoryEnabled(options, "US_TAX_ID")) scanMatches(content, US_TIN, "US_TAX_ID", 0.9, findings, context);
  if (categoryEnabled(options, "IBAN")) {
    IBAN.lastIndex = 0;
    let ibanMatch;
    while ((ibanMatch = IBAN.exec(content)) !== null) {
      const checksumOk = ibanChecksumOk(ibanMatch[0]);
      if (!checksumOk && !semanticEvidence(context, "IBAN").matched) continue;
      addFinding(findings, "IBAN", confidenceWithEvidence(checksumOk ? 0.96 : 0.72, context, "IBAN"), ibanMatch.index, ibanMatch.index + ibanMatch[0].length, ibanMatch[0], [checksumOk ? "iban_checksum" : "iban_shape+context"], context);
    }
  }
  if (categoryEnabled(options, "VAT_ID")) {
    VAT_ID.lastIndex = 0;
    let vatMatch;
    while ((vatMatch = VAT_ID.exec(content)) !== null) {
      addFinding(findings, "VAT_ID", confidenceWithEvidence(0.86, context, "VAT_ID", 0.96), vatMatch.index, vatMatch.index + vatMatch[0].length, vatMatch[0], ["vat_id_shape"], context);
    }
  }
  if (categoryEnabled(options, "MAC_ADDRESS")) scanMatches(content, MAC_ADDRESS, "MAC_ADDRESS", 0.92, findings, context);
  if (categoryEnabled(options, "POTENTIAL_SECRET")) {
    scanUrlSecrets(content, context, findings);
    scanMatches(
      content,
        GENERIC_SECRET,
        "POTENTIAL_SECRET",
        confidenceWithEvidence(0.66, context, "POTENTIAL_SECRET", 0.9),
        findings,
        context
      );
  }
  if (categoryEnabled(options, "STREET_ADDRESS")) {
    for (const candidate of addressCandidates(content)) {
      addFinding(findings, "STREET_ADDRESS", addressConfidence(candidate.value, context), candidate.start, candidate.end, candidate.value, ["address_shape"], context);
    }
  }

  if (categoryEnabled(options, "PHONE")) {
    PHONE.lastIndex = 0;
    let phoneMatch;
    while ((phoneMatch = PHONE.exec(content)) !== null) {
      const digits = phoneMatch[0].replace(/\D/g, "");
      if (digits.length < 7 || digits.length > 15) continue;
      if (DATE_LIKE.test(phoneMatch[0])) continue;
      if (overlapsFinding(findings, phoneMatch.index, phoneMatch.index + phoneMatch[0].length, ["IBAN"])) continue;
      addFinding(
        findings,
        "PHONE",
        confidenceWithEvidence(digits.length >= 10 ? 0.85 : 0.72, context, "PHONE"),
        phoneMatch.index,
        phoneMatch.index + phoneMatch[0].length,
        phoneMatch[0],
        [phoneContext ? "phone_pattern+context" : "phone_pattern"],
        context
      );
    }
  }

  if (categoryEnabled(options, "VIN")) {
    VIN.lastIndex = 0;
    let vinMatch;
    while ((vinMatch = VIN.exec(content)) !== null) {
      if (VIN_DISALLOWED.test(vinMatch[0])) continue;
      addFinding(findings, "VIN", 0.9, vinMatch.index, vinMatch.index + vinMatch[0].length, vinMatch[0], ["vin_pattern"], context);
    }
  }

  if (categoryEnabled(options, "PASSPORT")) {
    PASSPORT_GENERIC.lastIndex = 0;
    let passportMatch;
    while ((passportMatch = PASSPORT_GENERIC.exec(content)) !== null) {
      const value = passportMatch[0];
      if (PASSPORT_DISALLOWED.test(value)) continue;
      const alphaCount = (value.match(/[A-Z]/g) || []).length;
      const digitCount = (value.match(/\d/g) || []).length;
      const hinted = passportContext;
      const looksLikePassportNumber = alphaCount >= 1 && digitCount >= 5;
      if ((hinted && digitCount >= 4) || looksLikePassportNumber) {
        addFinding(findings, "PASSPORT", hinted ? 0.88 : 0.76, passportMatch.index, passportMatch.index + value.length, value, [hinted ? "field_hint:passport" : "passport_pattern"], context);
      }
    }

    MRZ_PASSPORT_NUMBER.lastIndex = 0;
    let mrzPassportMatch;
    while ((mrzPassportMatch = MRZ_PASSPORT_NUMBER.exec(content)) !== null) {
      addFinding(findings, "PASSPORT", 0.86, mrzPassportMatch.index, mrzPassportMatch.index + mrzPassportMatch[0].length, mrzPassportMatch[0], ["mrz_passport_pattern"], context);
    }

    MRZ_LINE.lastIndex = 0;
    let mrzLineMatch;
    while ((mrzLineMatch = MRZ_LINE.exec(content)) !== null) {
      addFinding(findings, "PASSPORT", 0.9, mrzLineMatch.index, mrzLineMatch.index + mrzLineMatch[0].length, mrzLineMatch[0], ["mrz_line_pattern"], context);
    }
  }

  if (categoryEnabled(options, "DRIVERS_LICENSE")) {
    DRIVERS_LICENSE_GENERIC.lastIndex = 0;
    let licenseMatch;
    while ((licenseMatch = DRIVERS_LICENSE_GENERIC.exec(content)) !== null) {
      if (!licenseContext) continue;
      addFinding(findings, "DRIVERS_LICENSE", 0.84, licenseMatch.index, licenseMatch.index + licenseMatch[0].length, licenseMatch[0], ["field_hint:drivers_license"], context);
    }
  }

  if (categoryEnabled(options, "CREDIT_CARD")) {
    const cardContext = contextContains(context, /(?:^|[_\-. ])(?:card|credit card|debit card|payment|cc|pan)$/i);
    CREDIT_CARD.lastIndex = 0;
    let ccMatch;
    while ((ccMatch = CREDIT_CARD.exec(content)) !== null) {
      if (overlapsFinding(findings, ccMatch.index, ccMatch.index + ccMatch[0].length, ["IBAN"])) continue;
      const checksumOk = luhnOk(ccMatch[0]);
      addFinding(
        findings,
        "CREDIT_CARD",
        boostConfidence(checksumOk ? 0.9 : 0.58, cardContext && !checksumOk, 0.14, 0.8),
        ccMatch.index,
        ccMatch.index + ccMatch[0].length,
        ccMatch[0],
        [checksumOk ? "luhn_pass" : (cardContext ? "luhn_soft_match+context" : "luhn_soft_match")],
        context
      );
    }
  }

  if (categoryEnabled(options, "BIC")) {
    BIC.lastIndex = 0;
    let bicMatch;
    while ((bicMatch = BIC.exec(content)) !== null) {
      const evidence = semanticEvidence(context, "BIC");
      const value = bicMatch[0];
      if (!evidence.matched && !/\b[A-Z]{4}(?:FI|SE|NO|DE|FR|GB|ES)[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/.test(value)) continue;
      addFinding(findings, "BIC", confidenceWithEvidence(0.78, context, "BIC", 0.94), bicMatch.index, bicMatch.index + value.length, value, [evidence.matched ? "bic_shape+context" : "bic_shape"], context);
    }
  }

  if (context.keyHint) {
    const trimmed = content.trim();
    if (trimmed) {
      if (categoryEnabled(options, "EMAIL") && emailContext && /^[A-Za-z0-9._%+\-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$/.test(trimmed)) {
        addFinding(findings, "EMAIL", 0.99, 0, content.length, content, ["field_hint:email"], context);
      } else if (categoryEnabled(options, "PHONE") && phoneContext && /^[+\d(][\d\s().-]{6,}$/.test(trimmed)) {
        addFinding(findings, "PHONE", 0.84, 0, content.length, content, ["field_hint:phone"], context);
      } else if (categoryEnabled(options, "US_TAX_ID") && taxIdContext && /^[A-Z0-9-]{8,15}$/.test(trimmed)) {
        addFinding(findings, "US_TAX_ID", 0.84, 0, content.length, content, ["field_hint:tax_id"], context);
      } else if (categoryEnabled(options, "PASSPORT") && passportContext && /^[A-Z0-9-]{6,12}$/.test(trimmed)) {
        addFinding(findings, "PASSPORT", 0.86, 0, content.length, content, ["field_hint:passport"], context);
      } else if (categoryEnabled(options, "DRIVERS_LICENSE") && licenseContext && /^[A-Z0-9-]{6,16}$/.test(trimmed)) {
        addFinding(findings, "DRIVERS_LICENSE", 0.82, 0, content.length, content, ["field_hint:drivers_license"], context);
      } else if (categoryEnabled(options, "VIN") && vinContext && /^[A-HJ-NPR-Z0-9]{17}$/.test(trimmed)) {
        addFinding(findings, "VIN", 0.9, 0, content.length, content, ["field_hint:vin"], context);
      } else if (categoryEnabled(options, "MAC_ADDRESS") && macContext && /^(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(trimmed)) {
        addFinding(findings, "MAC_ADDRESS", 0.92, 0, content.length, content, ["field_hint:mac"], context);
      } else if (categoryEnabled(options, "STREET_ADDRESS") && isLikelyStreetAddress(trimmed)) {
        addFinding(findings, "STREET_ADDRESS", addressConfidence(trimmed, context), 0, content.length, content, ["field_hint:address_shape"], context);
      }
    }
  }

  return findings;
}
