import { editDistanceWithin, extractIdentitySeeds, identityTokens } from "../utils.js";
import { semanticEvidence } from "./evidence.js";
import { addFinding, categoryEnabled } from "./shared.js";

const LABELLED_VALUE_PATTERN = /\b[\p{Script=Latin}\p{M}][\p{Script=Latin}\p{M}0-9 _./'-]{1,40}\s*[:=-]\s*([\p{Script=Latin}\p{M}][\p{Script=Latin}\p{M}.'\u2019-]+(?:[ \t]+[\p{Script=Latin}\p{M}][\p{Script=Latin}\p{M}.'\u2019-]+){1,3})/giu;

const CONTACT_SEGMENT_NAME = /^[\p{Script=Latin}\p{M}][\p{Script=Latin}\p{M}.'\u2019-]{1,}(?:\s+[\p{Script=Latin}\p{M}][\p{Script=Latin}\p{M}.'\u2019-]{1,}){1,2}$/u;
const CONTACT_SEGMENT_PLACE = /^[\p{Script=Latin}\p{M}][\p{Script=Latin}\p{M}.'\u2019-]{1,}(?:\s+[\p{Script=Latin}\p{M}][\p{Script=Latin}\p{M}.'\u2019-]{1,}){0,2}$/u;
const EMAIL_LOOSE = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,63}\b/g;
const IDENTITY_WORD = /[\p{Script=Latin}\p{M}0-9@$][\p{Script=Latin}\p{M}0-9@$.'\u2019-]*[\p{Script=Latin}\p{M}0-9@$]/gu;
const STANDALONE_NAME_LINE = /^[\p{Script=Latin}\p{M}][\p{Script=Latin}\p{M}.'\u2019-]{1,}(?:\s+[\p{Script=Latin}\p{M}][\p{Script=Latin}\p{M}.'\u2019-]{1,}){1,2}$/u;
const PROPER_NAME_TOKEN = /^[\p{Lu}][\p{Ll}\p{M}.'\u2019-]+$/u;
const NON_NAME_LINE_HINTS = /^(?:project manager|manager|owner|service owner|customer primary|customer secondary|incident response|runbook|rollback|support team|security team|engineering team)$/i;
const NON_NAME_TOKENS = new Set([
  "and", "or", "the", "for", "with", "from", "into", "onto", "over", "under",
  "project", "manager", "service", "owner", "customer", "primary", "secondary",
  "incident", "response", "rollback", "support", "security", "engineering", "team",
  "test", "sample", "internal", "external", "local", "browser",
]);
const COUNTRY_NAMES = new Set(`
afghanistan,albania,algeria,andorra,angola,argentina,armenia,australia,austria,azerbaijan,bahamas,bahrain,bangladesh,belarus,belgium,belize,bolivia,bosnia and herzegovina,botswana,brazil,bulgaria,cambodia,cameroon,canada,chile,china,colombia,costa rica,croatia,cyprus,czech republic,denmark,dominican republic,ecuador,egypt,el salvador,estonia,ethiopia,finland,france,georgia,germany,ghana,greece,guatemala,honduras,hong kong,hungary,iceland,india,indonesia,iran,iraq,ireland,israel,italy,jamaica,japan,jordan,kazakhstan,kenya,kuwait,latvia,lebanon,lithuania,luxembourg,malaysia,mexico,moldova,mongolia,morocco,netherlands,new zealand,nigeria,norway,pakistan,panama,peru,philippines,poland,portugal,qatar,romania,russia,saudi arabia,serbia,singapore,slovakia,slovenia,south africa,south korea,spain,sri lanka,sweden,switzerland,taiwan,thailand,tunisia,turkey,ukraine,united arab emirates,united kingdom,uk,united states,usa,uruguay,venezuela,vietnam
`.trim().split(","));

function addContextualNameFindings(content, findings, context) {
  LABELLED_VALUE_PATTERN.lastIndex = 0;
  let nameMatch;
  while ((nameMatch = LABELLED_VALUE_PATTERN.exec(content)) !== null) {
    const original = nameMatch[1];
    const labelHint = nameMatch[0].slice(0, nameMatch[0].indexOf(original)).replace(/[:=-]\s*$/, "").trim();
    if (!semanticEvidence({ ...context, keyHint: labelHint }, "PERSON").matched) continue;
    const start = nameMatch.index + nameMatch[0].indexOf(original);
    addFinding(findings, "PERSON", 0.73, start, start + original.length, original, ["labelled_identity_pattern"], context);
  }
}

function addFieldHintIdentityFindings(content, options, findings, context) {
  if (!options.detectNames || !context.keyHint) return;
  const trimmed = content.trim();
  if (!trimmed) return;
  const nameEvidence = semanticEvidence(context, "PERSON");
  const placeEvidence = semanticEvidence(context, "PLACE");
  const orgEvidence = semanticEvidence(context, "ORG");

  if (categoryEnabled(options, "PERSON") && nameEvidence.matched && /^[\p{Script=Latin}\p{M}][\p{Script=Latin}\p{M} ,.'\u2019-]{1,60}$/u.test(trimmed)) {
    addFinding(findings, "PERSON", Math.min(0.9, 0.72 + nameEvidence.score), 0, content.length, content, ["field_hint:name"], context);
  } else if (categoryEnabled(options, "PLACE") && placeEvidence.matched && /^[\p{Script=Latin}\p{M}][\p{Script=Latin}\p{M} ,.'\u2019-]{1,60}$/u.test(trimmed)) {
    addFinding(findings, "PLACE", Math.min(0.84, 0.66 + placeEvidence.score), 0, content.length, content, ["field_hint:place"], context);
  } else if (categoryEnabled(options, "ORG") && orgEvidence.matched && /^[\p{Script=Latin}\p{M}0-9][\p{Script=Latin}\p{M}0-9 &.,'\u2019-]{2,80}$/u.test(trimmed)) {
    addFinding(findings, "ORG", Math.min(0.84, 0.64 + orgEvidence.score), 0, content.length, content, ["field_hint:org"], context);
  }
}

function addContactLineIdentityFindings(content, findings, context) {
  const lines = content.split(/\r?\n/);
  let offset = 0;
  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;
    if (!line.includes(",")) continue;
    const parts = line.split(",").map((segment) => segment.trim()).filter(Boolean);
    if (parts.length < 2 || parts.length > 6) continue;
    const emailIndex = parts.findIndex((segment) => EMAIL_LOOSE.test(segment));
    EMAIL_LOOSE.lastIndex = 0;
    if (emailIndex === -1) continue;

    const countryIndex = parts.findIndex((segment, index) => index > emailIndex && COUNTRY_NAMES.has(segment.toLowerCase()));
    const cityIndex = countryIndex > emailIndex + 1 && CONTACT_SEGMENT_PLACE.test(parts[countryIndex - 1]) ? countryIndex - 1 : -1;

    let searchFrom = 0;
    parts.forEach((segment, index) => {
      const matchOffset = line.toLowerCase().indexOf(segment.toLowerCase(), searchFrom);
      if (matchOffset === -1) return;
      const start = lineStart + matchOffset;
      const end = start + segment.length;
      searchFrom = matchOffset + segment.length;

      if (index < emailIndex && CONTACT_SEGMENT_NAME.test(segment)) {
        const confidence = parts.length === 2 ? 0.78 : 0.74;
        addFinding(findings, "PERSON", confidence, start, end, segment, ["contact_line_name"], context);
        return;
      }
      if (index > emailIndex && (index === countryIndex || index === cityIndex) && CONTACT_SEGMENT_PLACE.test(segment)) {
        addFinding(findings, "PLACE", 0.72, start, end, segment, ["contact_line_place"], context);
      }
    });
  }
}

function lineNameCandidate(line, lineStart) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.includes(",") || trimmed.includes("@") || /\d/.test(trimmed)) return null;
  if (NON_NAME_LINE_HINTS.test(trimmed)) return null;

  const rawTokens = trimmed.split(/\s+/);
  const tokens = rawTokens.map((token) => token.toLowerCase());
  if (tokens.some((token) => NON_NAME_TOKENS.has(token))) return null;
  if (COUNTRY_NAMES.has(trimmed.toLowerCase())) return null;

  const startOffset = line.indexOf(trimmed);
  return {
    trimmed,
    rawTokens,
    tokens,
    start: lineStart + Math.max(0, startOffset),
  };
}

function pairKey(tokens, index = 0) {
  return tokens.slice(index, index + 2).join(" ");
}

function addStandaloneNameLineFindings(content, findings, context, externalSeeds = []) {
  const lines = content.split(/\r?\n/);
  let offset = 0;
  const lineCandidates = [];
  const candidates = [];
  const knownNamePairs = new Set(
    externalSeeds
      .filter((seed) => seed.label === "PERSON" && seed.tokens.length === 2)
      .map((seed) => seed.tokens.join(" "))
  );

  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;
    const candidate = lineNameCandidate(line, lineStart);
    if (!candidate) continue;
    lineCandidates.push(candidate);
    if (STANDALONE_NAME_LINE.test(candidate.trimmed) && candidate.rawTokens.length === 2) {
      knownNamePairs.add(pairKey(candidate.tokens));
    }
  }

  for (const { trimmed, rawTokens, tokens, start } of lineCandidates) {
    if (STANDALONE_NAME_LINE.test(trimmed)) {
      candidates.push({ start, end: start + trimmed.length, original: trimmed });
      continue;
    }

    const pairCounts = new Map();
    for (let index = 0; index < tokens.length; index += 2) {
      const key = pairKey(tokens, index);
      pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
    }
    const supportedPairs = tokens.every((_, index) => {
      if (index % 2 === 1) return true;
      const key = pairKey(tokens, index);
      return knownNamePairs.has(key) || (pairCounts.get(key) || 0) > 1;
    });
    const looksLikeAdjacentNames = rawTokens.length >= 4
      && rawTokens.length <= 20
      && rawTokens.length % 2 === 0
      && supportedPairs;
    if (!looksLikeAdjacentNames) continue;

    const tokenMatches = [...trimmed.matchAll(/\S+/gu)];
    for (let index = 0; index < tokenMatches.length; index += 2) {
      const pairStart = tokenMatches[index].index;
      const pairEnd = tokenMatches[index + 1].index + tokenMatches[index + 1][0].length;
      candidates.push({
        start: start + pairStart,
        end: start + pairEnd,
        original: trimmed.slice(pairStart, pairEnd),
      });
    }
  }

  const nameListConfidence = candidates.length >= 2 ? 0.84 : 0.63;
  for (const candidate of candidates) {
    const properCased = candidate.original
      .split(/\s+/)
      .every((token) => PROPER_NAME_TOKEN.test(token));
    const confidence = Math.max(nameListConfidence, properCased ? 0.82 : 0.63);
    addFinding(findings, "PERSON", confidence, candidate.start, candidate.end, candidate.original, ["standalone_name_line"], context);
  }
}

function sameIdentityTokens(seedTokens, candidateTokens) {
  if (seedTokens.length !== candidateTokens.length || !seedTokens.length) return false;
  return seedTokens.every((seed, index) => {
    const candidate = candidateTokens[index];
    if (seed === candidate) return true;
    if (seed.length < 4 || candidate.length < 4) return false;
    return editDistanceWithin(seed, candidate, 1);
  });
}

function propagateIdentitySeeds(content, findings, context, externalSeeds = []) {
  const localSeeds = extractIdentitySeeds(findings);
  const seeds = [...localSeeds, ...externalSeeds]
    .filter((seed, index, list) => list.findIndex((other) => other.label === seed.label && other.tokens.join(" ") === seed.tokens.join(" ")) === index);

  if (!seeds.length) return;

  // Try every run of 1-3 whitespace-separated words, longest first, so names inside sentences match too.
  const words = [...content.matchAll(IDENTITY_WORD)];
  for (let index = 0; index < words.length; index += 1) {
    for (let size = Math.min(3, words.length - index); size >= 1; size -= 1) {
      const window = words.slice(index, index + size);
      if (window.some((word, offset) => offset > 0 && !/^\s+$/.test(content.slice(window[offset - 1].index + window[offset - 1][0].length, word.index)))) continue;
      const start = window[0].index;
      const end = window.at(-1).index + window.at(-1)[0].length;
      const original = content.slice(start, end);
      const seed = seeds.find((item) => sameIdentityTokens(item.tokens, identityTokens(original)));
      if (!seed) continue;
      if (!findings.some((item) => item.label === seed.label && item.start === start && item.end === end)) {
        addFinding(findings, seed.label, 0.68, start, end, original, ["identity_seed_match"], context);
      }
      index += size - 1;
      break;
    }
  }
}

export function scanIdentityFindings(content, options = {}, context = {}, findings = []) {
  if (categoryEnabled(options, "PERSON")) {
    addContextualNameFindings(content, findings, context);
  }

  addFieldHintIdentityFindings(content, options, findings, context);

  if (options.detectNames && (categoryEnabled(options, "PERSON") || categoryEnabled(options, "PLACE"))) {
    addContactLineIdentityFindings(content, findings, context);
    if (categoryEnabled(options, "PERSON")) addStandaloneNameLineFindings(content, findings, context, options.identitySeeds || []);
    propagateIdentitySeeds(content, findings, context, options.identitySeeds || []);
  }

  return findings;
}
