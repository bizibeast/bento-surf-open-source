import { describe, expect, it } from "vitest";
import { freeTools } from "./mcp-free-text";
import { deterministicFreeToolSlugs, runDeterministicFreeTool } from "./mcp-free-text";

describe("MCP deterministic free tools", () => {
  it("covers every public link, measure, and format tool", () => {
    const slugs = freeTools
      .filter((tool) => ["Links", "Measure", "Format"].includes(tool.category))
      .map((tool) => tool.slug)
      .sort();
    expect([...deterministicFreeToolSlugs].sort()).toEqual(slugs);
  });

  it("builds the same normalized UTM parameters as the browser tool", () => {
    const result = runDeterministicFreeTool({
      toolSlug: "utm-link-builder",
      url: "bento.surf/features",
      source: "Instagram Stories",
      campaign: "Fall Launch",
      medium: "social",
    });
    expect(result).toMatchObject({
      url: "https://bento.surf/features?utm_source=instagram-stories&utm_medium=social&utm_campaign=fall-launch",
    });
    expect(() =>
      runDeterministicFreeTool({
        toolSlug: "utm-link-builder",
        url: "not a valid host",
        source: "Instagram",
        campaign: "Launch",
      }),
    ).toThrow();
  });

  it("counts Unicode characters and fixed platform limits", () => {
    expect(
      runDeterministicFreeTool({
        toolSlug: "social-media-character-counter",
        text: "Hi 👋",
        platform: "X",
      }),
    ).toMatchObject({ characters: 4, words: 2, lines: 1, limit: 280, remaining: 276 });
    expect(
      runDeterministicFreeTool({ toolSlug: "instagram-bio-counter", text: "Creator" }),
    ).toMatchObject({ characters: 7, limit: 150, remaining: 143, platform: null });
  });

  it("formats line breaks, Unicode styles, and thread boundaries", () => {
    expect(
      runDeterministicFreeTool({
        toolSlug: "social-post-formatter",
        text: "Hi  \r\n\r\n\r\nThere  ",
      }),
    ).toMatchObject({ text: "Hi\n\nThere" });
    expect(
      runDeterministicFreeTool({ toolSlug: "instagram-line-break-generator", text: "Hi\n\nThere" }),
    ).toMatchObject({ text: "Hi\n⠀\nThere" });
    expect(
      runDeterministicFreeTool({ toolSlug: "social-bold-italic-text", text: "Hi", style: "bold" }),
    ).toMatchObject({ text: "𝐇𝐢" });
    expect(
      runDeterministicFreeTool({
        toolSlug: "twitter-thread-splitter",
        text: "First second",
        numbered: true,
      }),
    ).toMatchObject({ posts: ["First second (1/1)"] });
  });
});
