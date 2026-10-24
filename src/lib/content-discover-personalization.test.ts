import { describe, expect, it } from "vitest";
import { contentProfileSchema, type BrainItem } from "./content-brain";
import {
  suggestDiscoverCreators,
  discoverBrainTopics,
  scoreDiscoverSource,
} from "./content-discover-personalization";
import type { CreatorDiscoverContext } from "./content-discovery.functions";
const brain: BrainItem = {
  id: "brain",
  kind: "instruction",
  title: "Writing voice",
  content: "I admire Alex Hormozi. Write direct copywriting with founder stories.",
  status: "confirmed",
  provenance: "creator",
  locked: true,
  sourceUrl: null,
  sourceRef: null,
  createdAt: "2026-10-01",
  updatedAt: "2026-10-01",
};
const context = (topics: string[], brainItems: BrainItem[] = []): CreatorDiscoverContext => ({
  profile: contentProfileSchema.parse({ nicheKeywords: topics }),
  brainItems,
  insights: [],
  feedbackSeeds: [],
});
describe("Discover personalization", () => {
  it("recommends relevant established creators even before any posts have loaded", () => {
    const result = suggestDiscoverCreators(context(["startup journey", "writing style", "hustle"]));
    expect(result.map((item) => item.name)).toContain("Alex Hormozi");
    expect(result.map((item) => item.name)).toContain("Justin Welsh");
    expect(result.every((item) => item.reason && item.profileUrl.startsWith("https://"))).toBe(
      true,
    );
    expect(suggestDiscoverCreators(context(["marine biology"]))).toEqual([]);
  });
  it("uses confirmed app Brain context and honors opting out", () => {
    const input = context([], [brain]);
    expect(suggestDiscoverCreators(input)[0]).toMatchObject({
      name: "Alex Hormozi",
      source: "brain",
    });
    expect(discoverBrainTopics(input)).toContain("writing");
    expect(suggestDiscoverCreators({ ...input, useBrainContext: false })).toEqual([]);
    expect(suggestDiscoverCreators(context([], [{ ...brain, status: "suggested" }]))).toEqual([]);
  });
  it("removes already tracked creators and ranks personal fit above general popularity", () => {
    const input = {
      ...context(["startup journey"], [brain]),
      creators: [
        {
          id: "tracked",
          name: "Alex Hormozi",
          profileUrl: "https://youtube.com/@AlexHormozi/",
          platform: "YouTube",
          topics: "business",
          avatarUrl: null,
        },
      ],
    };
    expect(suggestDiscoverCreators(input).map((item) => item.name)).not.toContain("Alex Hormozi");
    const relevant = scoreDiscoverSource(
      {
        title: "Founder storytelling",
        summary: "Copywriting lessons for bootstrapped founders",
        author: "",
        stats: {},
      },
      input,
    );
    const popular = scoreDiscoverSource(
      {
        title: "Football highlights",
        summary: "World cup",
        author: "",
        stats: { views: 10_000_000 },
      },
      input,
    );
    expect(relevant.score).toBeGreaterThan(popular.score);
    expect(relevant.reason).toContain("Brain");
  });
});

it("does not treat creators explicitly excluded in Brain instructions as inspiration", () => {
  const input = context(
    ["startup journey", "hustle"],
    [
      {
        ...brain,
        content: "Do not recommend Alex Hormozi. I prefer founder stories and thoughtful writing.",
      },
    ],
  );
  expect(suggestDiscoverCreators(input).map((item) => item.name)).not.toContain("Alex Hormozi");
});

it("also recommends creator profiles explicitly saved in Brain outside the reference list", () => {
  const input = context(
    ["startup journey"],
    [
      {
        ...brain,
        kind: "inspiration",
        title: "Founder inspiration",
        content: "Thoughtful founder writing",
        sourceUrl: "https://x.com/naval",
      },
    ],
  );
  expect(suggestDiscoverCreators(input)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ profileUrl: "https://www.x.com/naval", source: "brain" }),
    ]),
  );
  expect(
    suggestDiscoverCreators({ ...input, useBrainContext: false }).some((item) =>
      item.profileUrl.endsWith("/naval"),
    ),
  ).toBe(false);
});

it.each([
  ["lifestyle", "Emma Chamberlain"],
  ["comedy", "Trevor Noah"],
  ["fitness", "Jeff Nippard"],
  ["cooking", "Gordon Ramsay"],
  ["science", "Mark Rober"],
])("includes relevant established names for a %s Brain", (niche, name) => {
  const input = context(
    [],
    [
      {
        ...brain,
        kind: "profile",
        title: "My niche",
        content: `I create ${niche} content.`,
        tags: [niche],
      },
    ],
  );
  const names = suggestDiscoverCreators(input).map((creator) => creator.name);
  expect(names).toContain(name);
  expect(names).not.toContain("Alex Hormozi");
});

it("does not turn a comedian's writing style and marketing goals into a business niche", () => {
  const input = context(
    ["startup journey", "AI"],
    [
      {
        ...brain,
        title: "Comedy strategy",
        content:
          "I create comedy and stand-up sketches. Improve my writing style and marketing to grow my audience. I am not interested in startups or AI.",
      },
    ],
  );
  const names = suggestDiscoverCreators(input).map((creator) => creator.name);
  expect(names).toContain("Trevor Noah");
  expect(names).not.toContain("Alex Hormozi");
  expect(names).not.toContain("Justin Welsh");
  expect(discoverBrainTopics(input)).not.toContain("startup journey");
  expect(discoverBrainTopics(input)).not.toContain("AI");
});

it("ranks a specialized Brain interest ahead of unrelated viral posts", () => {
  const input = context(
    [],
    [
      {
        ...brain,
        title: "My work",
        content: "I teach marine biology and coral reef restoration.",
        tags: ["marine biology", "coral reef restoration"],
      },
    ],
  );
  expect(discoverBrainTopics(input)).toContain("coral reef restoration");
  const relevant = scoreDiscoverSource(
    { title: "Coral reef restoration", summary: "Marine biology in practice" },
    input,
  );
  const unrelated = scoreDiscoverSource(
    {
      title: "Founder marketing",
      summary: "Writing for startup growth",
      stats: { views: 50_000_000 },
    },
    input,
  );
  expect(relevant.score).toBeGreaterThan(unrelated.score);
  expect(relevant.reason).toContain("Brain");
});

it("does not interpret travel agents as an AI interest", () => {
  const input = context(
    [],
    [
      {
        ...brain,
        title: "Travel channel",
        content: "I share travel destinations and work with travel agents.",
      },
    ],
  );
  expect(discoverBrainTopics(input)).toEqual(["travel"]);
  expect(suggestDiscoverCreators(input).map((creator) => creator.name)).not.toContain(
    "Andrej Karpathy",
  );
});

it("does not turn generic Brain tags into standalone discovery topics", () => {
  const input = context(
    ["startup journey", "writing style", "hustle", "strategy"],
    [
      {
        ...brain,
        tags: ["challenge", "creativity", "AI", "public challenges"],
        content: "I make videos about AI tools and document building my startup.",
      },
    ],
  );
  expect(discoverBrainTopics(input)).not.toEqual(
    expect.arrayContaining(["challenge", "creativity", "public challenges"]),
  );
  expect(discoverBrainTopics(input)).toContain("ai");
});

it("does not turn unverified generated Brain notes into Discover interests or creator recommendations", () => {
  const unsupported = {
    ...brain,
    provenance: "social_post" as const,
    locked: false,
    tags: ["marine biology"],
    content: "I admire Sylvia Earle and build coral reef restoration businesses.",
  };
  const input = context([], [unsupported]);
  expect(discoverBrainTopics(input)).toEqual([]);
  expect(suggestDiscoverCreators(input)).toEqual([]);
});
