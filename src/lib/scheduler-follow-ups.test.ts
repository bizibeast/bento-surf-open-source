import { describe, expect, it } from "vitest";
import { splitXThread, xThreadError, linkedInFirstCommentError } from "./scheduler-follow-ups";
import { xPostTextLength } from "./x-account";
import { socialPostInputSchema, validatePostForProviders } from "./social-scheduler";

describe("X thread splitting", () => {
  it("splits long text at word boundaries without dropping words", () => {
    const text = Array.from({ length: 150 }, (_, i) => `word${i}`).join(" ");
    const parts = splitXThread(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join(" ")).toBe(text);
    expect(parts.every((part) => xPostTextLength(part) <= 280)).toBe(true);
  });
  it("preserves long URLs and counts them using X weighting", () => {
    const url = `https://example.com/${"long".repeat(100)}`;
    expect(splitXThread(`${"a".repeat(255)} ${url}`)).toEqual([`${"a".repeat(255)} ${url}`]);
    expect(splitXThread(`${"a".repeat(275)} ${url}`)).toEqual(["a".repeat(275), url]);
  });
  it("keeps emoji sequences intact when splitting unbroken text", () => {
    const emoji = "👨‍👩‍👧‍👦";
    const parts = splitXThread(emoji.repeat(150));
    expect(parts.join("")).toBe(emoji.repeat(150));
    expect(parts.every((part) => part.replaceAll(emoji, "") === "")).toBe(true);
    expect(parts.every((part) => xPostTextLength(part) <= 280)).toBe(true);
  });
  it("refuses more than 25 posts instead of truncating", () => {
    expect(() => splitXThread("a".repeat(280 * 25 + 1))).toThrow(/25/);
  });
  it("leaves short text alone and ignores empty input", () => {
    expect(splitXThread("Hello world")).toEqual(["Hello world"]);
    expect(splitXThread("  ")).toEqual([]);
  });
});

describe("follow-up validation", () => {
  it("validates every X part using the standard limit, including Premium accounts", () => {
    expect(xThreadError("First", { threadReplies: ["a".repeat(281)] })).toMatch(/280/);
    expect(xThreadError("a".repeat(281), { threadReplies: ["Reply"] })).toMatch(/280/);
    expect(xThreadError("First", { threadReplies: [""] })).toMatch(/text/);
    expect(xThreadError("First", { threadReplies: Array(25).fill("Reply") })).toMatch(/25/);
    expect(xThreadError("First", { kind: "article", threadReplies: ["Reply"] })).toMatch(
      /Articles/,
    );
    expect(xThreadError("First", { threadReplies: ["Reply"] })).toBeNull();
  });
  it("rejects malformed API settings even for drafts", () => {
    const base = { body: "First", connectionIds: [], asDraft: true, scheduledAt: null };
    expect(
      socialPostInputSchema.safeParse({
        ...base,
        providerSettings: { twitter: { threadReplies: "bad" } },
      }).success,
    ).toBe(false);
    expect(
      socialPostInputSchema.safeParse({
        ...base,
        providerSettings: { linkedin: { firstComment: "x".repeat(1251) } },
      }).success,
    ).toBe(false);
  });
  it("checks LinkedIn comments and reports provider errors", () => {
    expect(linkedInFirstCommentError({ firstComment: "x".repeat(1251) })).toMatch(/1,250/);
    expect(linkedInFirstCommentError({ firstComment: "  " })).toBeNull();
    expect(
      validatePostForProviders("First", [], ["twitter"], "", {
        twitter: { threadReplies: ["x".repeat(281)] },
      }).twitter,
    ).toMatch(/280/);
  });
});
