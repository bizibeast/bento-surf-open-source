import { describe, expect, it } from "vitest";
import {
  duplicateNewsletterBlock,
  moveNewsletterBlock,
  newsletterContentSchema,
  newsletterPlainText,
  newsletterPublicSlug,
} from "./newsletter";

describe("newsletter content", () => {
  it("normalizes public issue slugs", () => {
    expect(newsletterPublicSlug(" My First Issue! ")).toBe("my-first-issue");
  });

  it("builds plain-text campaign fallback", () => {
    expect(
      newsletterPlainText([
        { id: "1", type: "heading", text: "Launch" },
        { id: "2", type: "paragraph", text: "We are live." },
      ]),
    ).toBe("Launch\n\nWe are live.");
  });

  it("rejects unsafe links", () => {
    expect(() =>
      newsletterContentSchema.parse([
        { id: "1", type: "button", label: "Go", url: "javascript:alert(1)" },
      ]),
    ).toThrow();
  });

  it("accepts same-origin paths and HTTPS links", () => {
    expect(
      newsletterContentSchema.parse([
        { id: "1", type: "button", label: "Archive", url: "/newsletter" },
        {
          id: "2",
          type: "image",
          url: "https://cdn.example.com/launch.png",
          alt: "Launch",
        },
      ]),
    ).toHaveLength(2);
  });

  it("rejects invalid product references and documents over 100 blocks", () => {
    expect(() =>
      newsletterContentSchema.parse([{ id: "1", type: "product", productId: "not-a-uuid" }]),
    ).toThrow();
    expect(() =>
      newsletterContentSchema.parse(
        Array.from({ length: 101 }, (_, index) => ({
          id: String(index),
          type: "divider" as const,
        })),
      ),
    ).toThrow();
  });

  it("rejects documents over 100,000 serialized characters", () => {
    expect(() =>
      newsletterContentSchema.parse(
        Array.from({ length: 5 }, (_, index) => ({
          id: String(index),
          type: "paragraph" as const,
          text: "x".repeat(20_000),
        })),
      ),
    ).toThrow();
  });

  it("accepts visual sections and derives nested plain text in reading order", () => {
    const content = newsletterContentSchema.parse([
      {
        id: "hero",
        type: "section",
        layout: "two-left",
        style: { backgroundColor: "#fff4ea", padding: 24, borderRadius: 20 },
        columns: [
          [
            { id: "headline", type: "heading", text: "The main story" },
            { id: "copy", type: "paragraph", text: "What readers need to know." },
          ],
          [
            {
              id: "image",
              type: "image",
              url: "https://cdn.example.com/story.jpg",
              alt: "The featured story",
            },
          ],
        ],
      },
      { id: "quote", type: "quote", text: "Make it useful.", attribution: "Bento" },
      { id: "links", type: "list", ordered: false, items: ["First", "Second"] },
      { id: "space", type: "spacer", height: 24 },
    ]);

    expect(newsletterPlainText(content)).toBe(
      "The main story\n\nWhat readers need to know.\n\n[Image: The featured story]\n\n“Make it useful.” - Bento\n\nFirst\nSecond",
    );
  });

  it("rejects duplicate nested ids and arbitrary style values", () => {
    expect(() =>
      newsletterContentSchema.parse([
        {
          id: "section",
          type: "section",
          layout: "two-equal",
          columns: [
            [{ id: "same", type: "paragraph", text: "One" }],
            [{ id: "same", type: "paragraph", text: "Two" }],
          ],
        },
      ]),
    ).toThrow(/unique/i);
    expect(() =>
      newsletterContentSchema.parse([
        {
          id: "copy",
          type: "paragraph",
          text: "No arbitrary CSS",
          style: { backgroundColor: "url(javascript:alert(1))" },
        },
      ]),
    ).toThrow();
  });

  it("moves and duplicates blocks without mutating the source document", () => {
    const original = [
      { id: "a", type: "heading" as const, text: "A" },
      { id: "b", type: "paragraph" as const, text: "B" },
      { id: "c", type: "divider" as const },
    ];

    const moved = moveNewsletterBlock(original, 0, 2);
    const duplicated = duplicateNewsletterBlock(moved, 0, () => "copy-id");

    expect(original.map((block) => block.id)).toEqual(["a", "b", "c"]);
    expect(moved.map((block) => block.id)).toEqual(["b", "c", "a"]);
    expect(duplicated.map((block) => block.id)).toEqual(["b", "copy-id", "c", "a"]);
  });
});
