import { describe, expect, it } from "vitest";
import {
  commerceBuyerQuestions,
  commerceBuyerQuestionsVersion,
  commerceBuyerQuestionSettingsError,
  parseCommerceBuyerAnswers,
  buyerQuestionAnswersSchema,
} from "./commerce-buyer-questions";

const first = {
  id: "11111111-1111-4111-8111-111111111111",
  question: "Your goal?",
  required: true,
};
const second = {
  id: "22222222-2222-4222-8222-222222222222",
  question: "Anything else?",
  required: false,
};
const settings = (questions = [first, second]) => ({
  website: {
    sections: [{ id: "intake", title: "Before joining", body: "", buyerQuestions: questions }],
  },
});
const version = (value: unknown, kind = "course") =>
  commerceBuyerQuestionsVersion(commerceBuyerQuestions(value, kind));

describe("commerce buyer questions", () => {
  it("flattens section questions for all purchasable kinds with stable answer keys", () => {
    for (const kind of [
      "digital_product",
      "course",
      "webinar",
      "paid_community",
      "membership",
      "coaching_call",
      "custom_product",
      "bundle",
      "priority_dm",
      "newsletter",
    ]) {
      expect(commerceBuyerQuestions(settings(), kind)).toEqual([
        {
          ...first,
          answerKey: `bq_${first.id}`,
          sectionId: "intake",
          sectionTitle: "Before joining",
        },
        {
          ...second,
          answerKey: `bq_${second.id}`,
          sectionId: "intake",
          sectionTitle: "Before joining",
        },
      ]);
    }
    expect(commerceBuyerQuestions(settings(), "lead_form")).toEqual([]);
  });

  it("preserves legacy required custom questions without duplicate prompts", () => {
    const value = { ...settings(), buyerQuestions: ["Your goal?", "Company?"] };
    const questions = commerceBuyerQuestions(value, "custom_product");
    expect(questions.map((question) => question.answerKey)).toEqual([
      "q_0",
      "q_1",
      `bq_${second.id}`,
    ]);
    expect(
      parseCommerceBuyerAnswers({
        kind: "custom_product",
        settings: { buyerQuestions: ["Company?"] },
        answers: { q_0: " Bento " },
      }),
    ).toEqual([{ question: "Company?", answer: "Bento" }]);
  });

  it("uses canonical full labels and omits unanswered optional questions", () => {
    expect(
      parseCommerceBuyerAnswers({
        kind: "course",
        settings: settings(),
        answers: { [`bq_${first.id}`]: " Launch " },
        buyerQuestionsVersion: version(settings()),
      }),
    ).toEqual([{ question: "Your goal?", answer: "Launch" }]);
  });

  it("requires an up-to-date question version for section questions", () => {
    const input = {
      kind: "course",
      settings: settings(),
      answers: { [`bq_${first.id}`]: "Launch" },
    };
    expect(() => parseCommerceBuyerAnswers(input)).toThrow(/changed|refresh|version/i);
    expect(() =>
      parseCommerceBuyerAnswers({
        ...input,
        buyerQuestionsVersion: version(settings([{ ...first, question: "Old goal?" }, second])),
      }),
    ).toThrow(/changed|refresh|version/i);
    expect(() => parseCommerceBuyerAnswers({ ...input, buyerQuestionsVersion: "forged" })).toThrow(
      /changed|refresh|version/i,
    );
  });

  it("detects stale legacy-index labels when a version is supplied", () => {
    const old = { buyerQuestions: ["Company?"] };
    expect(() =>
      parseCommerceBuyerAnswers({
        kind: "custom_product",
        settings: { buyerQuestions: ["Phone?"] },
        answers: { q_0: "Bento" },
        buyerQuestionsVersion: version(old, "custom_product"),
      }),
    ).toThrow(/changed|refresh|version/i);
  });

  it("keeps versions stable across section reorder while binding IDs, labels and requiredness", () => {
    const questions = commerceBuyerQuestions(settings());
    const token = commerceBuyerQuestionsVersion(questions);
    expect(commerceBuyerQuestionsVersion([...questions].reverse())).toBe(token);
    expect(
      commerceBuyerQuestionsVersion([{ ...questions[0], required: false }, questions[1]]),
    ).not.toBe(token);
    const worst = Array.from({ length: 20 }, (_, index) => ({
      ...first,
      id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      question: '"\\\n'.repeat(165) + String(index),
    }));
    expect(
      commerceBuyerQuestionsVersion(commerceBuyerQuestions(settings(worst))).length,
    ).toBeLessThan(15_000);
  });

  it.each([
    [{}, /answer/i],
    [{ [`bq_${first.id}`]: "x".repeat(5001) }, /long|5,000/i],
    [{ [`bq_${first.id}`]: "Launch", forged: "Private instructions" }, /unknown|refresh|question/i],
    [{ [`bq_${first.id}`]: "Launch", priority_message: "forged follow-up" }, /unknown|question/i],
  ])("rejects missing, oversized or fabricated buyer answers: %j", (answers, error) => {
    expect(() =>
      parseCommerceBuyerAnswers({
        kind: "course",
        settings: settings(),
        answers,
        buyerQuestionsVersion: version(settings()),
      }),
    ).toThrow(error);
  });

  it("appends intake answers to the original priority message without follow-up metadata", () => {
    expect(
      parseCommerceBuyerAnswers({
        kind: "priority_dm",
        settings: settings(),
        answers: { priority_message: "Main message", [`bq_${first.id}`]: "Launch" },
        buyerQuestionsVersion: version(settings(), "priority_dm"),
      }),
    ).toEqual([
      { question: "Priority message", answer: "Main message" },
      { question: "Your goal?", answer: "Launch" },
    ]);
  });

  it("bounds configured count including legacy and reserves the priority message slot", () => {
    const twenty = Array.from({ length: 20 }, (_, index) => ({
      ...first,
      id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      question: `Question ${index}`,
    }));
    expect(commerceBuyerQuestionSettingsError(settings(twenty), "course")).toBeNull();
    expect(commerceBuyerQuestionSettingsError(settings(twenty), "priority_dm")).toMatch(
      /19|priority/i,
    );
    expect(
      commerceBuyerQuestionSettingsError(
        { ...settings(twenty), buyerQuestions: ["One more"] },
        "custom_product",
      ),
    ).toMatch(/20/);
    expect(
      commerceBuyerQuestionSettingsError(
        { ...settings(), buyerQuestions: [first.question] },
        "custom_product",
      ),
    ).toMatch(/unique|duplicate/i);
  });

  it("bounds raw request size before reading any product or provider", () => {
    expect(
      buyerQuestionAnswersSchema.safeParse(
        Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`q_${index}`, "answer"])),
      ).success,
    ).toBe(false);
    expect(buyerQuestionAnswersSchema.safeParse({ unknown: "x".repeat(10_001) }).success).toBe(
      false,
    );
    expect(
      buyerQuestionAnswersSchema.safeParse(
        Object.fromEntries(
          Array.from({ length: 11 }, (_, index) => [`q_${index}`, "x".repeat(5000)]),
        ),
      ).success,
    ).toBe(false);
  });
});
