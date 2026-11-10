/**
 * Grounding for the onboarding first draft. The draft may only state facts about the creator that
 * their onboarding answers or connected socials give. General how-to advice in their voice is fine;
 * invented teaching practice, "most beginners" style observations, outcomes, credentials and
 * anecdotes are not. This file holds the deterministic parts so they are testable without a model.
 */
import { normalizeDashes } from "../text/dashes";
import { normalizeEvidenceText, type BrainSource } from "./brain-evidence";

export type DraftSentence = {
  id: string;
  /** Which part of the draft: "title", "body" or "slide-<n>-heading" / "slide-<n>-body". */
  field: string;
  text: string;
};

/** The written rules shared by the writer request and the checker. */
export const DRAFT_GROUNDING_RULES = `Grounding rules for this first draft: the only facts about the creator are the ones in their onboarding answers and connected social profiles and posts. Rewording those facts is fine. Do not add first-person experience, practice or history they did not give: no "in my experience", "the mistake I see most often", "most beginners I teach", "my students", "where I start anyone in a first lesson", "what I tell people who ask", "when I started", and no invented lessons, classes, clients, results, credentials, years or anecdotes. Do not state how often something happens to people ("most beginners", "many people", "almost everyone") as an observation. The audience answer says who the creator wants to reach; it does not mean those people are already their students or clients. General how-to advice, tips, steps and opinions are welcome when written as advice to the reader ("Try one leaf first", "Start small"), not as reported experience.`;

const RISKY_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: "experience", pattern: /\bin my (?:experience|classes|lessons|workshops|teaching)\b/i },
  { kind: "experience", pattern: /\bfrom (?:my )?experience\b/i },
  {
    kind: "experience",
    pattern:
      /\b(?:i|we)(?:'ve| have)? (?:seen|noticed|watched|observed|found that|learned that)\b/i,
  },
  {
    kind: "experience",
    pattern:
      /\b(?:mistakes?|questions?|things?|problems?|pattern|struggles?)\s+(?:that\s+)?(?:i|we) (?:see|hear|get|notice|run into)\b/i,
  },
  {
    kind: "experience",
    pattern:
      /\b(?:i|we) see (?:it|this|that)? ?(?:all the time|again and again|every (?:week|day|time|class))\b/i,
  },
  {
    kind: "audience",
    pattern:
      /\b(?:my|our) (?:students?|clients?|customers?|learners?|members?|mentees?|class(?:es)?|lessons?|workshops?|courses?|cohorts?)\b/i,
  },
  {
    kind: "experience",
    pattern:
      /\b(?:beginners?|students?|clients?|people|learners?|painters?|creators?) (?:that |who |whom )?(?:i|we) (?:teach|coach|train|work with|meet|mentor|help)\b/i,
  },
  {
    kind: "experience",
    pattern:
      /\b(?:i|we) (?:always |usually |often |still )?(?:tell|teach|show|start|ask|give|walk|recommend|suggest)\b[^.!?\n]*\b(?:students?|clients?|anyone|everyone|beginners?|learners?|in (?:a|every|my|the) (?:first )?(?:lesson|class|session|workshop)|when (?:people|they|someone) ask)/i,
  },
  {
    kind: "experience",
    pattern: /\bwhen (?:people|students|clients|beginners|someone|anyone) asks? (?:me|us)?\b/i,
  },
  { kind: "experience", pattern: /\bpeople (?:always |often |usually |keep )?ask(?:ing)? me\b/i },
  {
    kind: "experience",
    pattern: /\b(?:in|during) (?:a|every|my|each) (?:first )?(?:lesson|class|session|workshop)\b/i,
  },
  {
    kind: "anecdote",
    pattern: /\bwhen i (?:first |was )?(?:started|began|starting|learning|new)\b/i,
  },
  {
    kind: "anecdote",
    pattern:
      /\b(?:i|we) (?:helped|taught|coached|trained|mentored|have worked with|worked with)\b/i,
  },
  {
    kind: "generalization",
    pattern:
      /\b(?:most|many|nearly all|almost all|almost every|the majority of|nine out of ten|so many) (?:of the )?(?:beginners?|students?|clients?|people|painters?|creators?|founders?|learners?|newcomers?|adults?|artists?|photographers?|writers?|parents?|new \w+)\b/i,
  },
  {
    kind: "generalization",
    pattern: /\b(?:almost )?every (?:beginner|student|client|learner|newcomer|painter)\b/i,
  },
  {
    kind: "credential",
    pattern: /\b(?:years|decades) of (?:teaching|experience|practice|painting|coaching)\b/i,
  },
  {
    kind: "credential",
    pattern:
      /\b(?:i|we)(?:'ve| have) been (?:teaching|painting|coaching|doing this|working)\b[^.!?\n]*\b(?:years?|decades?|since)\b/i,
  },
];

/** Risky phrases in one sentence that the creator's own evidence does not contain. */
export function unsupportedRiskyPhrases(sentence: string, evidenceText: string) {
  const evidence = normalizeEvidenceText(evidenceText);
  const found: Array<{ kind: string; phrase: string }> = [];
  for (const { kind, pattern } of RISKY_PATTERNS) {
    const match = sentence.match(pattern);
    if (!match) continue;
    const phrase = normalizeEvidenceText(match[0]);
    // The creator said it themselves, for example "in my experience" in a post.
    if (phrase && evidence.includes(phrase)) continue;
    found.push({ kind, phrase: match[0] });
  }
  return found;
}

const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=\S)/;

type DraftLike = {
  title: string;
  body: string;
  slides?: Array<{ heading: string; body: string; visualBrief?: string | null }>;
};

function fieldsOf(draft: DraftLike) {
  return [
    { field: "title", text: draft.title },
    { field: "body", text: draft.body },
    ...(draft.slides || []).flatMap((slide, index) => [
      { field: `slide-${index}-heading`, text: slide.heading },
      { field: `slide-${index}-body`, text: slide.body },
    ]),
  ];
}

/** Numbered sentences of every text field, so a checker can point at exact sentences. */
export function draftSentences(draft: DraftLike): DraftSentence[] {
  const sentences: DraftSentence[] = [];
  for (const { field, text } of fieldsOf(draft))
    for (const line of text.split("\n"))
      for (const sentence of line.split(SENTENCE_SPLIT))
        if (sentence.trim())
          sentences.push({ id: `s${sentences.length + 1}`, field, text: sentence.trim() });
  return sentences;
}

/**
 * Replace (rewrite) or remove (empty string) sentences by id, keeping the paragraph layout.
 * Ids follow draftSentences numbering of the same draft.
 */
export function applySentenceEdits<T extends DraftLike>(draft: T, edits: Map<string, string>): T {
  let counter = 0;
  const editField = (text: string) => {
    const lines = text.split("\n").map((line) => {
      const parts = line.split(SENTENCE_SPLIT);
      const kept = parts.flatMap((sentence) => {
        if (!sentence.trim()) return [sentence];
        const id = `s${++counter}`;
        if (!edits.has(id)) return [sentence];
        const next = normalizeDashes(edits.get(id)!.replace(/\s+/g, " ").trim());
        return next ? [next] : [];
      });
      // A line whose every sentence was removed disappears.
      return parts.some((part) => part.trim()) && !kept.some((part) => part.trim())
        ? null
        : kept.join(" ");
    });
    return lines
      .filter((line): line is string => line !== null)
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\n+|\n+$/g, "")
      .trim();
  };
  const title = editField(draft.title);
  const body = editField(draft.body);
  const slides = draft.slides
    ?.map((slide) => ({ ...slide, heading: editField(slide.heading), body: editField(slide.body) }))
    .filter((slide) => slide.body.trim());
  return {
    ...draft,
    title: title || draft.title,
    body,
    ...(slides
      ? { slides: slides.map((slide) => ({ ...slide, heading: slide.heading || "Tip" })) }
      : {}),
  };
}

/** Sentences the deterministic check still flags. */
export function flaggedSentences(draft: DraftLike, evidence: BrainSource[]) {
  const evidenceText = evidence.map((source) => source.text).join("\n");
  return draftSentences(draft).filter(
    (sentence) => unsupportedRiskyPhrases(sentence.text, evidenceText).length > 0,
  );
}

/** Evidence the checker may use: answers, connected profiles and the creator's own posts. */
export function draftEvidenceSummary(evidence: BrainSource[]) {
  return evidence.map(({ id, label, type, text }) => ({ id, label, type, text }));
}

/**
 * The audience answer says who the creator wants to reach. When no source calls them the
 * creator's students or clients, "my students are adults who..." is reworded to
 * "the people I want to reach are adults who...". Cheap and deterministic, used on the Brain.
 */
export function reframeAudienceAsExisting(content: string, evidenceText: string) {
  const evidence = normalizeEvidenceText(evidenceText);
  return content.replace(
    /\b(my|our) (students|clients|customers|learners)\b/gi,
    (match, owner: string, group: string) => {
      if (evidence.includes(normalizeEvidenceText(`${owner} ${group}`))) return match;
      const replacement = `the people ${owner.toLowerCase() === "our" ? "we" : "I"} want to reach`;
      // Keep the original capitalization: "My students" starts a sentence, "my students" does not.
      return /^[A-Z]/.test(owner)
        ? replacement[0].toUpperCase() + replacement.slice(1)
        : replacement;
    },
  );
}
