export function fnv1a(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return hash >>> 0;
}

export function base36Token(seed, length = 10) {
  let token = "";
  let current = seed >>> 0;
  while (token.length < length) {
    current = (current * 1664525 + 1013904223) >>> 0;
    token += current.toString(36);
  }
  return token.slice(0, length);
}

export function detectLineEnding(text) {
  if (text.includes("\r\n")) return "\r\n";
  if (text.includes("\r")) return "\r";
  return "\n";
}

export function withTrailingNewline(text, lineEnding, trailingNewline) {
  return trailingNewline ? `${text}${lineEnding}` : text;
}

export function summarise(findings) {
  return {
    total: findings.length,
    high: findings.filter((item) => item.confidence >= 0.8).length,
    medium: findings.filter((item) => item.confidence < 0.8).length,
  };
}

export function annotateFindings(findings) {
  return findings.map((item, index) => ({
    ...item,
    id: `f-${String(index + 1).padStart(4, "0")}`,
    replacement: "[REDACTED]",
  }));
}

export function descendingReplacementOrder(left, right) {
  return right.start - left.start || right.end - left.end;
}

export function ascendingFindingOrder(left, right) {
  return left.start - right.start || right.end - left.end || left.label.localeCompare(right.label);
}

const IDENTITY_LEET_MAP = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "6": "g",
  "7": "t",
  "8": "b",
  "@": "a",
  "$": "s",
};

export function normalizeIdentityText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[01345678@$]/g, (char) => IDENTITY_LEET_MAP[char] || char)
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function identityTokens(value) {
  const normalized = normalizeIdentityText(value);
  return normalized ? normalized.split(" ") : [];
}

export function editDistanceWithin(left, right, limit = 1) {
  if (left === right) return true;
  if (!left || !right) return false;
  if (Math.abs(left.length - right.length) > limit) return false;

  const rows = left.length + 1;
  const cols = right.length + 1;
  const matrix = Array.from({ length: rows }, (_, rowIndex) =>
    Array.from({ length: cols }, (_, colIndex) => (rowIndex === 0 ? colIndex : (colIndex === 0 ? rowIndex : 0)))
  );

  for (let row = 1; row < rows; row += 1) {
    let rowMin = Number.POSITIVE_INFINITY;
    for (let col = 1; col < cols; col += 1) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      matrix[row][col] = Math.min(
        matrix[row - 1][col] + 1,
        matrix[row][col - 1] + 1,
        matrix[row - 1][col - 1] + cost
      );
      rowMin = Math.min(rowMin, matrix[row][col]);
    }
    if (rowMin > limit) return false;
  }

  return matrix[rows - 1][cols - 1] <= limit;
}

export function extractIdentitySeeds(findings, minimumConfidence = 0.72) {
  return findings
    .filter((item) => ["PERSON", "PLACE", "ORG"].includes(item.label) && item.confidence >= minimumConfidence)
    .map((item) => ({
      label: item.label,
      original: item.original,
      tokens: identityTokens(item.original),
    }))
    .filter((seed) => seed.tokens.length > 0)
    .filter((seed, index, list) => (
      list.findIndex((other) => other.label === seed.label && other.tokens.join(" ") === seed.tokens.join(" ")) === index
    ));
}

export function dedupeFindings(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const contextKey = JSON.stringify({
      previewPath: finding.context?.previewPath,
      rowIndex: finding.context?.rowIndex,
      columnIndex: finding.context?.columnIndex,
      tableIndex: finding.context?.tableIndex,
      sheetIndex: finding.context?.sheetIndex,
      segmentIndex: finding.context?.segmentIndex,
      path: finding.context?.path,
      pageNumber: finding.context?.pageNumber,
      kind: finding.context?.kind,
    });
    const key = [
      finding.label,
      finding.start,
      finding.end,
      finding.original,
      Math.round((finding.confidence || 0) * 1000),
      contextKey,
    ].join("::");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Loads a vendored browser bundle once and returns the global it defines.
export async function loadVendorScript(src, globalName, isReady) {
  if (isReady(globalThis[globalName])) return globalThis[globalName];
  let script = document.querySelector(`script[src="${src}"]`);
  if (!script) {
    script = document.createElement("script");
    script.src = src;
    script.async = true;
    document.head.appendChild(script);
  }
  await new Promise((resolve, reject) => {
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener("error", () => {
      script.remove();
      reject(new Error(`Local ${globalName} bundle not found at ${src}.`));
    }, { once: true });
  });
  if (!isReady(globalThis[globalName])) throw new Error(`Local ${globalName} bundle is missing or incomplete.`);
  return globalThis[globalName];
}
