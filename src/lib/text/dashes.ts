// Shared dash policy for text Bento writes or ships.
// textHasForbiddenDash flags a dash anywhere, including code and URLs. SEO plain text uses that.
// proseHasForbiddenDash skips URLs and Markdown code. Social posts and DMs use that.
// Numeric ranges such as 10-20, including chains such as 10-20-30, are allowed. The normaliser
// rewrites those ranges to ASCII hyphens and other dash runs to one spaced hyphen.
// URLs and Markdown code are left unchanged. Spaced ASCII hyphens stay as written.

const PROTECTED_SOURCE = "```[\\s\\S]*?```|`[^`\\n]*`|https?:\\/\\/[^\\s<>)\\]\"']+";
const DASH_CHAR_SOURCE = "\\u2014\\u2015\\u2012\\u2E3A\\u2E3B\\uFE58\\u2013";
const DASH_RUN_SOURCE = `[ \\t]*(?:[${DASH_CHAR_SOURCE}][ \\t]*)+`;
const NUMERIC_CHAIN_SOURCE = `\\d(?:[\\d.,]*\\d)?(?:[ \\t]*\\u2013[ \\t]*\\d(?:[\\d.,]*\\d)?)+`;

function mapProse(value: string, edit: (prose: string) => string) {
  let result = "";
  let cursor = 0;
  for (const match of value.matchAll(new RegExp(PROTECTED_SOURCE, "g"))) {
    const index = match.index ?? 0;
    result += edit(value.slice(cursor, index));
    result += match[0];
    cursor = index + match[0].length;
  }
  return result + edit(value.slice(cursor));
}

function spacedHyphen(segment: string, source: string) {
  return segment.replace(new RegExp(source, "g"), (match, offset) => {
    const leading = /^[ \t]/.test(match);
    const trailing = /[ \t]$/.test(match);
    const start = offset === 0 && !leading;
    const end = offset + match.length === segment.length && !trailing;
    if (start && end) return "-";
    if (start) return "- ";
    if (end) return " -";
    return " - ";
  });
}

function hyphenateRanges(segment: string) {
  return segment.replace(new RegExp(NUMERIC_CHAIN_SOURCE, "g"), (match) =>
    match.replace(new RegExp("[ \\t]*\\u2013[ \\t]*", "g"), "-"),
  );
}

function normalizeProse(segment: string) {
  return spacedHyphen(hyphenateRanges(segment), DASH_RUN_SOURCE);
}

/** True when any forbidden dash remains, including inside code or URLs. Numeric ranges are allowed. */
export function textHasForbiddenDash(value: string) {
  const withoutRanges = hyphenateRanges(value);
  return new RegExp(`[${DASH_CHAR_SOURCE}]`).test(withoutRanges);
}

/** True when prose outside URLs and code uses a dash Bento does not ship. */
export function proseHasForbiddenDash(value: string) {
  let found = false;
  mapProse(value, (prose) => {
    if (found) return prose;
    if (textHasForbiddenDash(prose)) found = true;
    return prose;
  });
  return found;
}

/** Rewrite forbidden dashes. Numeric ranges become hyphens. URLs and code stay. */
export function normalizeDashes(value: string) {
  return mapProse(value, normalizeProse);
}

export function normalizeOptionalCopy(value: string | null | undefined) {
  if (value == null) return null;
  return normalizeDashes(value);
}

/** Deep-copy strings through the normaliser. Non-strings stay as they are. */
export function normalizeCustomerCopy<T>(value: T): T {
  if (typeof value === "string") return normalizeDashes(value) as T;
  if (Array.isArray(value)) return value.map((item) => normalizeCustomerCopy(item)) as T;
  if (value && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) next[key] = normalizeCustomerCopy(item);
    return next as T;
  }
  return value;
}
