import { afterEach, expect, it, vi } from "vitest";
import { contentProfileSchema } from "./content-brain";
import type { CreatorDiscoverContext } from "./content-discovery.functions";
import type { ContentSourceItem } from "./content-sources.server";
import { runAiJson } from "./ai-json.server";
import { buildDiscoverIdeas, fallbackDiscoverIdeas } from "./content-discover-ideas.server";

vi.mock("./ai-json.server", () => ({ runAiJson: vi.fn() }));
const now = new Date("2026-10-11T12:00:00Z");
const source: ContentSourceItem = {
  canonicalUrl: "https://www.youtube.com/watch?v=reef2026",
  title: "Restoring a damaged coral nursery",
  summary:
    "The team compares two ways of attaching coral fragments and explains their limitations.",
  sourceName: "Reef Project",
  author: "Marine Educator",
  publishedAt: "2026-10-10T12:00:00Z",
  retrievedAt: now.toISOString(),
  kind: "youtube",
  platform: "YouTube",
};
const context: CreatorDiscoverContext = {
  profile: contentProfileSchema.parse({
    nicheKeywords: ["marine biology"],
    language: "es",
    region: "es",
  }),
  brainItems: [
    {
      id: "brain",
      kind: "profile",
      title: "My audience",
      content: "I teach marine biology to beginners.",
      tags: [],
      status: "confirmed",
      provenance: "creator",
      locked: false,
      sourceUrl: null,
      sourceRef: null,
      createdAt: "2026-10-01",
      updatedAt: "2026-10-01",
    },
  ],
  feedbackSeeds: [],
  insights: [],
};
const generated = {
  sourceUrl: source.canonicalUrl,
  title: "Cómo explicar la restauración de coral sin perder a tu audiencia",
  summary:
    "Crea una explicación visual de cómo se fijan fragmentos de coral y qué preguntas deberías hacer antes de elegir un método.",
  hook: "¿Cómo se fija un fragmento de coral a un arrecife dañado?",
  format: "Carrusel educativo",
  outline: [
    "Presenta el problema con un dibujo original.",
    "Compara los métodos descritos por la fuente.",
    "Explica las limitaciones y enlaza la publicación original.",
  ],
};

afterEach(() => vi.clearAllMocks());

it("creates distinct source-specific production briefs even without AI", () => {
  const ideas = fallbackDiscoverIdeas(
    [
      source,
      {
        ...source,
        canonicalUrl: "https://example.org/reef-light",
        title: "Reef lighting experiment",
      },
    ],
    context,
    now,
  );
  expect(ideas).toHaveLength(2);
  expect(ideas[0].title).not.toBe(source.title);
  expect(ideas[0].summary).not.toBe(source.summary);
  expect(ideas[0].inspiration.outline[0]).toContain("attaching coral fragments");
  expect(ideas[0].inspiration.outline).toHaveLength(3);
  expect(ideas[0].inspiration.format).not.toBe(ideas[1].inspiration.format);
  expect(ideas[0].inspiration.whyNow).toContain("this week");
  expect(ideas[0].sourceUrl).toBe(source.canonicalUrl);
});

it("uses the matching tracked creator's focus without forcing unrelated profile topics", () => {
  const creator = {
    id: "founder",
    name: "Founder",
    platform: "Facebook",
    profileUrl: "https://www.facebook.com/founder",
    topics: "bootstrapping",
    avatarUrl: null,
  };
  const followedSource = {
    ...source,
    canonicalUrl: "https://www.facebook.com/founder/posts/123",
    authorUrl: creator.profileUrl,
    title: "How I funded the first product",
    summary: "A breakdown of early customer revenue.",
  };
  const creatorContext = {
    ...context,
    profile: contentProfileSchema.parse({ nicheKeywords: ["artificial intelligence"] }),
    creators: [creator],
  };
  const idea = fallbackDiscoverIdeas([followedSource], creatorContext, now)[0];
  expect(idea.angles.join(" ")).toContain("bootstrapping");
  expect(idea.angles.join(" ")).toContain("early customer revenue");
  expect(idea.angles.join(" ")).not.toContain("artificial intelligence");
  expect(fallbackDiscoverIdeas([source], creatorContext, now)[0].angles.join(" ")).not.toContain(
    "bootstrapping",
  );
});

it("does not use retrieval time as evidence of freshness or invent viral performance", () => {
  const undated = fallbackDiscoverIdeas([{ ...source, publishedAt: null }], context, now)[0];
  expect(undated.inspiration.whyNow).toContain("recency is unverified");
  const archived = fallbackDiscoverIdeas(
    [{ ...source, publishedAt: "2023-01-01" }],
    context,
    now,
  )[0];
  expect(archived.inspiration.whyNow).toContain("older creative reference");
  expect(JSON.stringify(undated)).not.toMatch(/viral|million views|trending/i);
});

it("bounds generation and uses the creator's language and confirmed Brain only", async () => {
  vi.mocked(runAiJson).mockResolvedValue({ provider: "workers-ai", value: { ideas: [generated] } });
  const result = await buildDiscoverIdeas(
    [source],
    {
      ...context,
      brainItems: [
        ...context.brainItems,
        { ...context.brainItems[0], status: "suggested", content: "Unconfirmed" },
      ],
    },
    now,
  );
  expect(result[0].title).toBe(generated.title);
  expect(result[0].inspiration.hook).toBe(generated.hook);
  expect(runAiJson).toHaveBeenCalledWith(
    expect.objectContaining({
      timeoutMs: 15_000,
      input: expect.objectContaining({
        language: "es",
        region: "es",
        brain: [expect.objectContaining({ content: context.brainItems[0].content })],
      }),
    }),
    expect.anything(),
  );
});

it("keeps five production steps while capping persisted angles at three", async () => {
  const outline = [
    ...generated.outline,
    "Invita a tu audiencia a compartir sus preguntas.",
    "Revisa cada afirmación antes de publicar.",
  ];
  vi.mocked(runAiJson).mockResolvedValue({
    provider: "workers-ai",
    value: { ideas: [{ ...generated, outline }] },
  });
  const result = await buildDiscoverIdeas([source], context, now);
  expect(result[0].angles).toEqual(outline.slice(0, 3));
  expect(result[0].inspiration.outline).toEqual(outline);
});

it("cleans hashtags and uses real caption text instead of a generic social profile title", () => {
  const hashtagSource = {
    ...source,
    title: "Restore damaged coral nurseries #coral #reef #ocean #biology #research #nature",
  };
  const hashtagIdea = fallbackDiscoverIdeas([hashtagSource], context, now)[0];
  expect(hashtagIdea.title).toContain("Restore damaged coral nurseries");
  expect(hashtagIdea.title).not.toContain("#");
  const profileSource = {
    ...source,
    author: "Matthew Chang",
    title: "Matthew Chang (@MatthewChang) on X",
    summary:
      "Matthew Chang on X: Three ways to fund your first product with customer revenue. #startup #funding",
  };
  const profileIdea = fallbackDiscoverIdeas([profileSource], context, now)[0];
  expect(profileIdea.title).toContain("Three ways to fund your first product");
  expect(profileIdea.title).not.toContain("Matthew Chang");
  expect(profileIdea.inspiration.hook).not.toContain("@MatthewChang");
  expect(profileIdea.angles[0]).toContain("customer revenue");
  expect(profileIdea.angles[0]).not.toContain("#");
});

it("uses only a source-matched focus when a profile label has no substantive caption", async () => {
  const creator = {
    id: "matt",
    name: "Matthew Chang",
    platform: "X",
    profileUrl: "https://x.com/MatthewChang",
    topics: "bootstrapping",
    avatarUrl: null,
  };
  const profileSource = {
    ...source,
    author: creator.name,
    authorUrl: creator.profileUrl,
    canonicalUrl: "https://x.com/MatthewChang/status/123",
    title: "Matthew Chang (@MatthewChang) on X",
    summary: "",
  };
  const result = await buildDiscoverIdeas(
    [profileSource],
    { ...context, creators: [creator] },
    now,
  );
  expect(result[0].title).toContain("bootstrapping");
  expect(result[0].angles[0]).toContain("in the original before drafting");
  expect(runAiJson).not.toHaveBeenCalled();
});

it("omits metadata-only sources without a matching focus instead of creating placeholder ideas", async () => {
  const metadataOnly = {
    ...source,
    canonicalUrl: "https://x.com/MatthewChang/status/123",
    author: "Matthew Chang",
    title: "Matthew Chang (@MatthewChang) on X",
    summary: "",
  };
  expect(fallbackDiscoverIdeas([metadataOnly], context, now)).toEqual([]);
  expect(await buildDiscoverIdeas([metadataOnly], context, now)).toEqual([]);
  expect(runAiJson).not.toHaveBeenCalled();
  vi.mocked(runAiJson).mockResolvedValue({ provider: "workers-ai", value: { ideas: [generated] } });
  const result = await buildDiscoverIdeas([metadataOnly, source], context, now);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ sourceUrl: source.canonicalUrl, title: generated.title });
});

it("rejects invented links and copy-pasted posts and returns useful fallbacks", async () => {
  vi.mocked(runAiJson).mockResolvedValue({
    provider: "workers-ai",
    value: { ideas: [{ ...generated, sourceUrl: "https://invented.example/post" }] },
  });
  expect(await buildDiscoverIdeas([source], context, now)).toEqual(
    fallbackDiscoverIdeas([source], context, now),
  );
  vi.mocked(runAiJson).mockResolvedValue({
    provider: "workers-ai",
    value: { ideas: [{ ...generated, title: source.title, summary: source.summary }] },
  });
  expect(await buildDiscoverIdeas([source], context, now)).toEqual(
    fallbackDiscoverIdeas([source], context, now),
  );
  vi.mocked(runAiJson).mockResolvedValue({
    provider: "workers-ai",
    value: {
      ideas: [
        {
          ...generated,
          summary: "Use the amazing method at https://invented.example/method for this post.",
        },
      ],
    },
  });
  expect(await buildDiscoverIdeas([source], context, now)).toEqual(
    fallbackDiscoverIdeas([source], context, now),
  );
});

it("deduplicates sources, limits the batch and falls back after a provider timeout", async () => {
  vi.mocked(runAiJson).mockRejectedValue(new DOMException("Timed out", "TimeoutError"));
  const sources = Array.from({ length: 12 }, (_, index) => ({
    ...source,
    canonicalUrl: `https://example.org/post-${index}`,
    title: `Coral nursery question ${index}`,
  }));
  const result = await buildDiscoverIdeas(
    [sources[0], ...sources],
    { ...context, useBrainContext: false },
    now,
  );
  expect(result).toHaveLength(8);
  expect(new Set(result.map((idea) => idea.sourceUrl)).size).toBe(8);
  expect(runAiJson).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({ brain: [] }),
    }),
    expect.anything(),
  );
});

it("keeps YouTube as evidence while rejecting automatic video output suggestions", async () => {
  vi.mocked(runAiJson).mockResolvedValue({
    value: { ideas: [{ ...generated, format: "YouTube short script" }] },
  } as never);
  const result = await buildDiscoverIdeas([source], context, now);
  expect(result[0].sourceUrl).toBe(source.canonicalUrl);
  expect(result[0].inspiration.format).toBe("Instagram static carousel");
  expect(vi.mocked(runAiJson).mock.calls.at(-1)?.[0].input).toMatchObject({
    automaticFormats: { twitter: "post", linkedin: "post", instagram: "carousel" },
  });
});
