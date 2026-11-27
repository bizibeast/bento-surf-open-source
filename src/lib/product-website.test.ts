import { describe, it, expect } from "vitest";
import {
  productWebsite,
  productWebsiteSchema,
  downloadBenefit,
  productAccentTextColor,
} from "./product-website";
import { sanitizeCommerceSettingsForPublic } from "./commerce";
describe("standalone product websites", () => {
  it("preserves buyer intake questions on any product page with required as the default", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const website = productWebsite({
      sections: [
        {
          id: "intake",
          title: "Before you join",
          body: "Help me tailor your experience",
          buyerQuestions: [{ id, question: "What are you working on?" }],
        },
      ],
    });
    expect(website.sections[0]).toMatchObject({
      buyerQuestions: [{ id, question: "What are you working on?", required: true }],
    });
    const publicSettings = sanitizeCommerceSettingsForPublic("paid_community", {
      website,
      meetingUrl: "https://private.example.com",
      buyer_answers: [{ question: "secret", answer: "private" }],
    });
    expect(publicSettings.website?.sections[0]).toMatchObject({
      buyerQuestions: [{ id, question: "What are you working on?", required: true }],
    });
    expect(JSON.stringify(publicSettings)).not.toContain("private");
  });

  it("rejects duplicate IDs, duplicate prompts, and more than twenty section questions", () => {
    const first = { id: "11111111-1111-4111-8111-111111111111", question: "Your goal?" };
    const second = { id: "22222222-2222-4222-8222-222222222222", question: "Your experience?" };
    const sections = (questions: unknown[]) => ({
      sections: [{ id: "intake", title: "Intake", body: "", buyerQuestions: questions }],
    });
    expect(
      productWebsiteSchema.safeParse(sections([first, { ...second, id: first.id }])).success,
    ).toBe(false);
    expect(
      productWebsiteSchema.safeParse(sections([first, { ...second, question: "  YOUR GOAL?  " }]))
        .success,
    ).toBe(false);
    expect(productWebsiteSchema.safeParse(sections([{ ...first, question: "" }])).success).toBe(
      false,
    );
    expect(
      productWebsiteSchema.safeParse(sections([{ ...first, question: "x".repeat(501) }])).success,
    ).toBe(false);
    expect(
      productWebsiteSchema.safeParse({
        sections: [
          {
            id: "one",
            title: "One",
            body: "",
            buyerQuestions: Array.from({ length: 11 }, (_, i) => ({
              id: `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
              question: `Question ${i}`,
            })),
          },
          {
            id: "two",
            title: "Two",
            body: "",
            buyerQuestions: Array.from({ length: 10 }, (_, i) => ({
              id: `20000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
              question: `Question ${i + 11}`,
            })),
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("preserves ordered public sections without exposing private downloads", () => {
    const website = productWebsite({
      brand: "Studio",
      accent: "#224466",
      sections: [
        { id: "b", title: "Why it works", body: "Our approach", imageUrl: "" },
        { id: "a", title: "Questions", body: "Answers", imageUrl: "" },
      ],
    });
    const result = sanitizeCommerceSettingsForPublic("digital_product", {
      website,
      files: [{ name: "secret.pdf", url: "https://example.com/private.pdf" }],
    });
    expect(result.website).toEqual(website);
    expect(JSON.stringify(result)).not.toContain("private.pdf");
  });
  it("validates website settings and keeps raw file names out of benefits", () => {
    expect(productWebsiteSchema.safeParse({ accent: "url(javascript:alert(1))" }).success).toBe(
      false,
    );
    expect(
      productWebsiteSchema.safeParse({
        sections: [{ id: "a", title: "", body: "", imageUrl: "javascript:alert(1)" }],
      }).success,
    ).toBe(false);
    expect(downloadBenefit("ChatGPT Image Aug 4, 2026.png", 0)).toBe("Image download 1");
  });
});

it("uses readable text for light and dark brand colors", () => {
  expect(productAccentTextColor("#ffffff")).toBe("#000000");
  expect(productAccentTextColor("#eeb637")).toBe("#000000");
  expect(productAccentTextColor("#3478f6")).toBe("#ffffff");
  expect(productAccentTextColor("#27665c")).toBe("#ffffff");
});
