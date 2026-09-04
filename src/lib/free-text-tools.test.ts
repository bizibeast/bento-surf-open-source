import { describe, expect, it } from "vitest";
import { splitThreadText, stylizeUnicodeText } from "./free-text-tools";

describe("exact free text tools", () => {
  it("converts supported ASCII without changing punctuation", () => {
    expect(stylizeUnicodeText("Bento 2.0!", "bold")).toBe("𝐁𝐞𝐧𝐭𝐨 𝟐.𝟎!");
    expect(stylizeUnicodeText("hello", "italic")).toContain("ℎ");
  });

  it("splits and numbers a thread without exceeding the limit", () => {
    const posts = splitThreadText("one two three four five six seven eight nine ten", true, 24);
    expect(posts.length).toBeGreaterThan(1);
    expect(posts.every((post) => Array.from(post).length <= 24)).toBe(true);
    expect(posts[0]).toMatch(/\(1\/\d+\)$/);
  });
});
