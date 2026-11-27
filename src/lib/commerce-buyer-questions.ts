import { z } from "zod";
import type { CommerceBuyerAnswer } from "./commerce";

export const MAX_COMMERCE_BUYER_QUESTIONS = 20;
export const MAX_COMMERCE_BUYER_ANSWER_LENGTH = 5_000;
export const MAX_COMMERCE_BUYER_QUESTIONS_VERSION_LENGTH = 15_000;

export const commerceBuyerQuestionSchema = z.object({
  id: z.string().uuid(),
  question: z.string().trim().min(1, "Write a buyer question.").max(500),
  required: z.boolean().default(true),
});
export type CommerceBuyerQuestion = z.infer<typeof commerceBuyerQuestionSchema>;
export type CanonicalCommerceBuyerQuestion = CommerceBuyerQuestion & {
  answerKey: string;
  sectionId?: string;
  sectionTitle?: string;
};

export function normalizeBuyerQuestionLabel(question: string) {
  return question.trim().replace(/\s+/g, " ").toLowerCase();
}

export const buyerQuestionAnswersSchema = z
  .record(z.string().max(40), z.string().max(10_000))
  .refine(
    (value) => Object.keys(value).length <= MAX_COMMERCE_BUYER_QUESTIONS,
    "Too many checkout answers.",
  )
  .refine((value) => JSON.stringify(value).length <= 50_000, "Checkout answers are too large.");

export const buyerQuestionsVersionSchema = z
  .string()
  .max(MAX_COMMERCE_BUYER_QUESTIONS_VERSION_LENGTH)
  .optional();

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function questionSections(rawSettings: unknown) {
  const sections = record(record(rawSettings).website).sections;
  return Array.isArray(sections) ? sections.map(record) : [];
}

export function commerceBuyerQuestionSettingsError(
  rawSettings: unknown,
  kind?: string,
): string | null {
  if (kind === "lead_form" || kind === "bento_affiliate") return null;
  const settings = record(rawSettings);
  const legacy = !kind || kind === "custom_product" ? settings.buyerQuestions : undefined;
  if (
    legacy !== undefined &&
    (!Array.isArray(legacy) ||
      legacy.some(
        (question) =>
          typeof question !== "string" || !question.trim() || question.trim().length > 500,
      ))
  )
    return "Buyer questions must be between 1 and 500 characters.";
  const labels = new Set<string>();
  const ids = new Set<string>();
  let count = 0;
  for (const question of Array.isArray(legacy) ? legacy : []) {
    count += 1;
    const label = normalizeBuyerQuestionLabel(question);
    if (labels.has(label)) return "Buyer questions must be unique.";
    labels.add(label);
  }
  for (const section of questionSections(settings)) {
    if (section.buyerQuestions === undefined) continue;
    if (!Array.isArray(section.buyerQuestions))
      return "Add valid buyer questions to the custom section.";
    for (const candidate of section.buyerQuestions) {
      const parsed = commerceBuyerQuestionSchema.safeParse(candidate);
      if (!parsed.success)
        return "Buyer questions need a stable ID, a prompt of 1 to 500 characters, and a required setting.";
      count += 1;
      const label = normalizeBuyerQuestionLabel(parsed.data.question);
      if (ids.has(parsed.data.id) || labels.has(label))
        return "Buyer questions must have unique IDs and prompts.";
      ids.add(parsed.data.id);
      labels.add(label);
    }
  }
  const max =
    kind === "priority_dm" ? MAX_COMMERCE_BUYER_QUESTIONS - 1 : MAX_COMMERCE_BUYER_QUESTIONS;
  return count > max
    ? `Add no more than ${max} buyer questions${kind === "priority_dm" ? "; the priority message uses one answer" : " across all custom sections and legacy questions"}.`
    : null;
}

/** Only definitions are public; submitted answers never enter this projection. */
export function commerceBuyerQuestions(
  rawSettings: unknown,
  kind?: string,
): CanonicalCommerceBuyerQuestion[] {
  if (kind === "lead_form" || kind === "bento_affiliate") return [];
  const settings = record(rawSettings);
  const questions: CanonicalCommerceBuyerQuestion[] = [];
  const ids = new Set<string>();
  const labels = new Set<string>();
  const add = (question: CanonicalCommerceBuyerQuestion) => {
    const label = normalizeBuyerQuestionLabel(question.question);
    if (
      !label ||
      ids.has(question.id) ||
      labels.has(label) ||
      questions.length >= MAX_COMMERCE_BUYER_QUESTIONS
    )
      return;
    ids.add(question.id);
    labels.add(label);
    questions.push(question);
  };
  if ((!kind || kind === "custom_product") && Array.isArray(settings.buyerQuestions)) {
    settings.buyerQuestions.slice(0, MAX_COMMERCE_BUYER_QUESTIONS).forEach((question, index) => {
      if (typeof question === "string" && question.trim() && question.trim().length <= 500)
        add({
          id: `legacy_${index}`,
          question: question.trim(),
          required: true,
          answerKey: `q_${index}`,
        });
    });
  }
  for (const section of questionSections(settings)) {
    if (!Array.isArray(section.buyerQuestions)) continue;
    for (const candidate of section.buyerQuestions) {
      const parsed = commerceBuyerQuestionSchema.safeParse(candidate);
      if (parsed.success)
        add({
          ...parsed.data,
          answerKey: `bq_${parsed.data.id}`,
          sectionId: String(section.id || "").slice(0, 100),
          sectionTitle: String(section.title || "")
            .trim()
            .slice(0, 120),
        });
    }
  }
  return questions;
}

/** Collision-free optimistic concurrency token, not an authorization secret. */
export function commerceBuyerQuestionsVersion(questions: CanonicalCommerceBuyerQuestion[]) {
  return (
    "bq1|" +
    [...questions]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(
        (question) =>
          `${question.id.length}:${question.id}${question.question.length}:${question.question}${question.required ? "1" : "0"}`,
      )
      .join("")
  );
}

export function parseCommerceBuyerAnswers(input: {
  kind: string;
  settings: unknown;
  answers: Record<string, string>;
  buyerQuestionsVersion?: string;
}): CommerceBuyerAnswer[] {
  // Lead forms have their own field schema and mutation; never share namespaces.
  if (input.kind === "lead_form" || input.kind === "bento_affiliate") return [];
  const settingsError = commerceBuyerQuestionSettingsError(input.settings, input.kind);
  if (settingsError) throw new Error(settingsError);
  const answers = buyerQuestionAnswersSchema.parse(input.answers);
  const questions = commerceBuyerQuestions(input.settings, input.kind);
  const hasSectionQuestions = questions.some((question) => question.sectionId !== undefined);
  if (
    (hasSectionQuestions || input.buyerQuestionsVersion !== undefined) &&
    input.buyerQuestionsVersion !== commerceBuyerQuestionsVersion(questions)
  )
    throw new Error("The buyer questions changed. Refresh this product page before continuing.");
  const allowedKeys = new Set(questions.map((question) => question.answerKey));
  if (input.kind === "priority_dm") allowedKeys.add("priority_message");
  if (Object.keys(answers).some((key) => !allowedKeys.has(key)))
    throw new Error("Unknown buyer question. Refresh this product page before continuing.");
  const output: CommerceBuyerAnswer[] = [];
  if (input.kind === "priority_dm") {
    const message = String(answers.priority_message || "").trim();
    if (!message) throw new Error("Write your message before continuing.");
    output.push({ question: "Priority message", answer: message });
  }
  for (const question of questions) {
    const answer = String(answers[question.answerKey] || "").trim();
    if (!answer && question.required)
      throw new Error(`Answer "${question.question}" before continuing.`);
    if (answer.length > MAX_COMMERCE_BUYER_ANSWER_LENGTH)
      throw new Error(
        `Answer "${question.question}" is too long. Use no more than 5,000 characters.`,
      );
    if (answer) output.push({ question: question.question, answer });
  }
  return output;
}
