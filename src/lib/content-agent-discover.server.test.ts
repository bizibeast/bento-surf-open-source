import { beforeEach, expect, it, vi } from "vitest";
const fixtures = vi.hoisted(() => ({
  profile: { niche_keywords: ["startup journey"], language: "en", region: "global" },
  items: [] as unknown[],
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const query = {
        select: () => query,
        eq: () => query,
        gte: () => query,
        order: () => query,
        limit: () => query,
        maybeSingle: async () => ({
          data: table === "creator_content_profiles" ? fixtures.profile : { items: fixtures.items },
          error: null,
        }),
      };
      return query;
    },
  },
}));
import {
  filterAgentDiscoverSources,
  loadAgentDiscoverResearch,
  loadFreshBriefSources,
} from "./content-agent-discover.server";
const fictional = {
  id: "fiction",
  title: "A Rich CEO Humiliated a Courier… Then Learned Who Really Owned the Company!",
  summary:
    "A ruthless tech founder arrives expecting a $20 million investment. A fictional twist reveals his mistake.",
  sourceUrl: "https://example.com/fiction",
};
const relevant = {
  id: "real",
  title: "Startup founder shares customer research lessons",
  summary:
    "The founder describes how the business changed its product after interviewing customers in their market.",
  sourceUrl: "https://example.com/research",
};
beforeEach(() => {
  fixtures.items = [];
});
it("removes fictional saved history from ambient Agent recommendations without modifying it", () => {
  const rows = [{ ...fictional, feedback: "saved" }, relevant];
  expect(filterAgentDiscoverSources(rows, ["startup journey"])).toEqual([relevant]);
  expect(rows).toHaveLength(2);
  expect(filterAgentDiscoverSources(rows, [])).toEqual([]);
});
it("preserves an explicitly referenced bookmark for discussion even when it is off-topic", () => {
  const saved = { ...fictional, saved: true };
  expect(
    filterAgentDiscoverSources(
      [saved],
      ["startup journey"],
      "Please analyze my saved post https://example.com/fiction",
    ),
  ).toEqual([saved]);
  expect(
    filterAgentDiscoverSources(
      [saved],
      ["startup journey"],
      `Discuss my bookmark: ${fictional.title}`,
    ),
  ).toEqual([saved]);
});
it("filters the fresh cached source loader and retains its existing array API", async () => {
  fixtures.items = [fictional, relevant].map((item) => ({
    canonicalUrl: item.sourceUrl,
    title: item.title,
    summary: item.summary,
    sourceName: "Public source",
    publishedAt: new Date().toISOString(),
    retrievedAt: new Date().toISOString(),
    kind: "social_search",
    platform: "X",
  }));
  const context = await loadAgentDiscoverResearch("owner");
  expect(context.nicheKeywords).toEqual(["startup journey"]);
  expect(context.sources.map((item) => item.source_url)).toEqual([relevant.sourceUrl]);
  expect(await loadFreshBriefSources("owner")).toEqual(context.sources);
});
