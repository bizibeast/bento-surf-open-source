import { describe, expect, it } from "vitest";
import {
  brainItemInputSchema,
  contentProfileSchema,
  groupBrainItems,
  mergeBrainSuggestions,
  type BrainItem,
} from "./content-brain";

const confirmedVoice: BrainItem = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "instruction",
  title: "Voice",
  content: "Direct",
  provenance: "creator",
  sourceUrl: null,
  sourceRef: null,
  status: "confirmed",
  locked: true,
  createdAt: "2026-09-18T00:00:00.000Z",
  updatedAt: "2026-09-18T00:00:00.000Z",
};

describe("content Brain", () => {
  it("rejects unsafe or unbounded source data", () => {
    expect(() =>
      brainItemInputSchema.parse({
        kind: "story",
        title: "Launch story",
        content: "A".repeat(20_001),
        provenance: "link",
        sourceUrl: "javascript:alert(1)",
      }),
    ).toThrow();
    expect(() =>
      brainItemInputSchema.parse({
        kind: "link",
        title: "Bad link",
        content: "Unsafe",
        provenance: "link",
        sourceUrl: "file:///etc/passwd",
      }),
    ).toThrow();
  });

  it("bounds profile frequency and known social providers", () => {
    expect(
      contentProfileSchema.parse({
        goal: "consistent_publishing",
        nicheKeywords: ["creator economy"],
        language: "en",
        region: "global",
        timezone: "Asia/Kolkata",
        platformFrequencies: { linkedin: 5, instagram: 3 },
      }),
    ).toMatchObject({ platformFrequencies: { linkedin: 5, instagram: 3 } });
    expect(() =>
      contentProfileSchema.parse({
        nicheKeywords: [],
        language: "en",
        region: "global",
        timezone: "UTC",
        platformFrequencies: { unknown: 1 },
      }),
    ).toThrow();
  });

  it("never overwrites confirmed or locked knowledge with an inference", () => {
    expect(
      mergeBrainSuggestions(
        [confirmedVoice],
        [
          {
            kind: "instruction",
            title: "Voice",
            content: "Formal",
            provenance: "social_post",
            sourceRef: "linkedin:1",
          },
        ],
      ),
    ).toEqual({ kept: [confirmedVoice], suggestions: [] });
  });

  it("deduplicates suggestions and groups items without losing order", () => {
    const result = mergeBrainSuggestions(
      [],
      [
        {
          kind: "story",
          title: "Launch",
          content: "First version",
          provenance: "social_post",
          sourceRef: "linkedin:1",
        },
        {
          kind: "story",
          title: " Launch ",
          content: "Duplicate",
          provenance: "social_post",
          sourceRef: "linkedin:1",
        },
      ],
    );
    expect(result.suggestions).toHaveLength(1);
    expect(groupBrainItems([confirmedVoice])).toEqual({
      profile: [],
      instruction: [confirmedVoice],
      strategy: [],
      story: [],
      inspiration: [],
      file: [],
      photo: [],
      link: [],
    });
  });
});
