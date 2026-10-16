import { describe, expect, it } from "vitest";
import {
  discoverAgentPrompt,
  creatorKey,
  formatStat,
  relativePublishedAt,
  youtubeEmbedUrl,
} from "./discover-utils";
import type { DiscoverRecommendation } from "@/lib/content-discovery.functions";

describe("Discover data display", () => {
  it("distinguishes a count of one from an engagement percentage", () => {
    expect(formatStat(1)).toBe("1");
    expect(formatStat(0)).toBe("0");
    expect(formatStat(0.12, true)).toBe("12%");
    expect(formatStat(125_000)).toBe("125K");
  });
  it("handles missing, malformed and older dates", () => {
    const now = new Date("2026-10-06T12:00:00Z");
    expect(relativePublishedAt("invalid", now)).toBe("");
    expect(relativePublishedAt(null, now)).toBe("");
    expect(relativePublishedAt("2026-09-01T12:00:00Z", now)).toBe("1mo");
    expect(relativePublishedAt("2026-10-06T10:00:00Z", now)).toBe("2h");
  });
  it("only embeds valid video IDs on recognized YouTube hosts", () => {
    const id = "dQw4w9WgXcQ";
    for (const url of [
      `https://www.youtube.com/watch?v=${id}`,
      `https://youtu.be/${id}`,
      `https://youtube.com/shorts/${id}`,
    ])
      expect(youtubeEmbedUrl(url)).toBe(`https://www.youtube-nocookie.com/embed/${id}`);
    for (const url of [
      null,
      "javascript:alert(1)",
      "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/watch?v=bad",
      "http://youtu.be/dQw4w9WgXcQ",
    ])
      expect(youtubeEmbedUrl(url)).toBeNull();
  });
  it("keeps source context and gives each Boost action its own instruction", () => {
    const post = {
      title: "A real post",
      sourceUrl: "https://example.com/post",
      summary: "The original context",
    } as DiscoverRecommendation;
    const prompts = ["chat", "variations", "reverse-engineer", "replicate"].map((action) =>
      discoverAgentPrompt(post, action as Parameters<typeof discoverAgentPrompt>[1]),
    );
    expect(new Set(prompts).size).toBe(4);
    for (const prompt of prompts)
      expect(prompt).toContain("https://example.com/post\nThe original context");
  });
});

it("keeps unknown creators separate until their identities have resolved", () => {
  const a = {
    id: "a",
    platform: "Instagram",
    author: null,
    sourceName: "Instagram",
    sourceUrl: "https://www.instagram.com/reel/aaaaaa/",
  } as DiscoverRecommendation;
  const b = { ...a, id: "b", sourceUrl: "https://www.instagram.com/reel/bbbbbb/" };
  expect(creatorKey(a)).not.toBe(creatorKey(b));
  expect(creatorKey(a)).toBe(creatorKey({ ...a, id: "idea-a" }));
});

it("carries a creation brief into Agent with source attribution and original angles", () => {
  const idea = {
    kind: "idea",
    title: "Make a workflow experiment",
    summary: "Test a process in your own context.",
    sourceUrl: "https://example.com/source",
    angles: ["Compare the before and after"],
    inspiration: {
      hook: "I tried this for a week",
      format: "Short video",
      outline: ["Show your starting point", "Share the actual result"],
      whyNow: "A recent discussion",
    },
  } as DiscoverRecommendation;
  const prompt = discoverAgentPrompt(idea, "replicate");
  expect(prompt).toContain("https://example.com/source");
  expect(prompt).toContain("Suggested opening hook: I tried this for a week");
  expect(prompt).toContain("1. Show your starting point");
  expect(prompt).toContain("Compare the before and after");
  expect(prompt).toContain("do not invent performance claims");
});

it("adapts legacy video ideas to supported editorial output when creating drafts", () => {
  const prompt = discoverAgentPrompt(
    {
      id: "reef-idea",
      fingerprint: "reef-source",
      sourceName: "Reef educator",
      sourcePublishedAt: null,
      sourceRetrievedAt: null,
      reason: "A useful source",
      metricName: null,
      metricValue: null,
      outlierScore: null,
      feedback: "pending",
      title: "A reef decision",
      sourceUrl: "https://example.com/reef",
      summary: "Source evidence",
      angles: [],
      kind: "idea",
      inspiration: {
        hook: "A reef question",
        format: "YouTube short script",
        outline: ["Explain the reef decision"],
        whyNow: "A durable lesson",
      },
    } as Parameters<typeof discoverAgentPrompt>[0],
    "replicate",
  );
  expect(prompt).toContain("X single text post, LinkedIn text post, or Instagram static carousel");
  expect(prompt).toContain("source context only");
});
