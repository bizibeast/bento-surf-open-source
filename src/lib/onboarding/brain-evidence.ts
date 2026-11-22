/**
 * Evidence for the onboarding Brain. Every source (onboarding answers, connected profiles and
 * imported posts) is split into short numbered snippets that are verbatim substrings of the
 * source. The writer cites snippet ids; the code inserts the snippet text as the quote, so the
 * model never retypes evidence. Matching is tolerant of paraphrase but still requires the claim's
 * content words, numbers and names to come from the cited evidence.
 */

export type BrainSource = {
  id: string;
  label: string;
  type: string;
  url: string | null;
  text: string;
};
export type EvidenceSnippet = { id: string; sourceId: string; text: string };

const MAX_SNIPPET_CHARS = 420;
export const MAX_EVIDENCE_SNIPPETS = 220;

function splitLong(text: string): string[] {
  if (text.length <= MAX_SNIPPET_CHARS) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > MAX_SNIPPET_CHARS) {
    const cut = rest.lastIndexOf(" ", MAX_SNIPPET_CHARS);
    const at = cut > 80 ? cut : MAX_SNIPPET_CHARS;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Lines, then sentences. Each snippet is an exact substring of its source text. */
export function buildEvidenceSnippets(sources: BrainSource[]): EvidenceSnippet[] {
  const snippets: EvidenceSnippet[] = [];
  for (const source of sources) {
    for (const line of source.text.split(/\n+/)) {
      for (const sentence of line.split(/(?<=[.!?])\s+(?=\S)/)) {
        for (const part of splitLong(sentence.trim())) {
          if (part.replace(/\W/g, "").length < 3) continue;
          if (snippets.length >= MAX_EVIDENCE_SNIPPETS) return snippets;
          snippets.push({ id: `e${snippets.length + 1}`, sourceId: source.id, text: part });
        }
      }
    }
  }
  return snippets;
}

const STOPWORDS = new Set(
  "a an and are as at be been but by can for from has have he her his i i'm im in into is it its me my of on or our she so that the their them they this to was we were what when which who will with you your about also just more most very than then there these those do does did not no yes how why all any each some such own same too only over under again further once here out up down off".split(
    " ",
  ),
);

/** Lowercase, unify quotes and dashes, drop punctuation and collapse whitespace. */
export function normalizeEvidenceText(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018\u2019\u201a\u201b\u2032`]/g, "'")
    .replace(/[\u201c\u201d\u201e\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[^\p{L}\p{N}'%$.\s-]/gu, " ")
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stem(word: string) {
  const w = word.replace(/^'+|'+$/g, "").replace(/'s$/, "");
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function contentTokens(value: string) {
  return normalizeEvidenceText(value)
    .split(" ")
    .map((word) => word.replace(/^[-']+|[-']+$/g, ""))
    .filter((word) => word.length > 2 && !STOPWORDS.has(word))
    .map(stem);
}

const numbersIn = (value: string) => normalizeEvidenceText(value).match(/\d+(?:[.,]\d+)?%?/g) ?? [];

/** Capitalized words that are not the first word of a sentence: likely names, places, employers. */
function namesIn(value: string) {
  const names = new Set<string>();
  for (const sentence of value.split(/(?<=[.!?:])\s+|\n+/)) {
    const words = sentence.trim().split(/\s+/).slice(1);
    for (const raw of words) {
      const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      if (/^\p{Lu}[\p{L}\p{N}'-]{1,}/u.test(word) && !/^I('|$)/.test(word))
        names.add(stem(word.toLowerCase()));
    }
  }
  return [...names];
}

/**
 * How well evidence supports a claim: the share of the claim's content words found in the
 * evidence. Numbers and names must appear in the evidence exactly or the claim is unsupported.
 */
export function evidenceSupport(claim: string, evidence: string) {
  const claimTokens = [...new Set(contentTokens(claim))];
  if (!claimTokens.length) return 0;
  const evidenceTokens = new Set(contentTokens(evidence));
  const normalizedEvidence = normalizeEvidenceText(evidence);
  if (numbersIn(claim).some((number) => !normalizedEvidence.includes(number))) return 0;
  if (namesIn(claim).some((name) => !evidenceTokens.has(name))) return 0;
  const hits = claimTokens.filter((token) => evidenceTokens.has(token)).length;
  return hits / claimTokens.length;
}

/** Paraphrases need most of their content words from the evidence. */
export const SUPPORT_THRESHOLD = 0.6;

export type DraftClaim = {
  text: string;
  evidence?: string[];
  sourceId?: string;
  quote?: string;
};
export type GroundedClaim = { text: string; sourceId: string; quote: string };

/**
 * Resolve one claim to verbatim evidence. Cited snippets are tried first, then a free quote,
 * then any snippet from the creator's sources. Returns null when nothing supports it.
 */
export function groundClaim(
  claim: DraftClaim,
  snippets: EvidenceSnippet[],
): GroundedClaim[] | null {
  const byId = new Map(snippets.map((snippet) => [snippet.id, snippet]));
  const cited = (claim.evidence ?? [])
    .map((id) => byId.get(String(id).trim()))
    .filter((snippet): snippet is EvidenceSnippet => Boolean(snippet));
  const asGrounded = (items: EvidenceSnippet[]) =>
    items.map((snippet) => ({ text: claim.text, sourceId: snippet.sourceId, quote: snippet.text }));
  if (
    cited.length &&
    evidenceSupport(claim.text, cited.map((s) => s.text).join(" ")) >= SUPPORT_THRESHOLD
  )
    return asGrounded(cited);
  if (claim.quote) {
    const quote = normalizeEvidenceText(claim.quote);
    const matching = snippets.filter((snippet) => {
      const text = normalizeEvidenceText(snippet.text);
      return quote.length >= 6 && (text.includes(quote) || quote.includes(text));
    });
    if (
      matching.length &&
      evidenceSupport(claim.text, matching.map((s) => s.text).join(" ")) >= SUPPORT_THRESHOLD
    )
      return asGrounded(matching.slice(0, 3));
  }
  const ranked = snippets
    .map((snippet) => ({ snippet, score: evidenceSupport(claim.text, snippet.text) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  if (ranked[0] && ranked[0].score >= SUPPORT_THRESHOLD) return asGrounded([ranked[0].snippet]);
  // A claim can combine two short snippets, such as an answer and a profile headline.
  if (
    ranked.length >= 2 &&
    evidenceSupport(claim.text, ranked.map((item) => item.snippet.text).join(" ")) >=
      SUPPORT_THRESHOLD
  )
    return asGrounded(ranked.map((item) => item.snippet));
  return null;
}

/** Remove the sentences or list lines that state an unsupported statement. */
export function removeStatement(content: string, statement: string) {
  const target = normalizeEvidenceText(statement);
  if (target.length < 6) return content;
  const lines = content.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (/^\s*#/.test(line)) {
      kept.push(line);
      continue;
    }
    const sentences = line.split(/(?<=[.!?])\s+(?=\S)/);
    const survivors = sentences.filter((sentence) => {
      const normalized = normalizeEvidenceText(sentence);
      if (!normalized) return true;
      return !(
        normalized.includes(target) ||
        (normalized.length >= 12 && target.includes(normalized))
      );
    });
    if (survivors.length === sentences.length) kept.push(line);
    else if (survivors.join(" ").replace(/[-*\s]/g, "").length) {
      const bullet = line.match(/^\s*(?:[-*]|\d+\.)\s+/)?.[0] ?? "";
      const body = survivors.join(" ").replace(/^\s*(?:[-*]|\d+\.)\s+/, "");
      kept.push(`${bullet}${body}`);
    }
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Snippet ids are for the model only. Remove any that leak into prose, such as "(e2)". */
export function stripEvidenceIds(content: string) {
  return content
    .replace(/\s*[([]\s*(?:snippets?\s*)?e\d{1,3}(?:\s*(?:,|;|and)\s*e\d{1,3})*\s*[)\]]/gi, "")
    .replace(/[ \t]+([.,;:!?])/g, "$1");
}
