import { afterEach, expect, it, vi } from "vitest";
import { contentProfileSchema } from "./content-brain";
import type { CreatorDiscoverContext } from "./content-discovery.functions";
import { discoverResearchInput, researchDiscoverContext } from "./content-discover-research.server";

const context: CreatorDiscoverContext = {
  profile: contentProfileSchema.parse({ language: "en", region: "in" }),
  brainItems: [
    {
      id: "mine",
      kind: "profile",
      title: "My niche",
      content: "I teach coral reef restoration and marine biology.",
      tags: ["marine biology"],
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
const plan = {
  topics: ["marine biology", "coral reef restoration"],
  excludedTopics: ["startup"],
  creators: [
    { name: "Sylvia Earle", topics: ["marine biology"] },
    { name: "Unverified Person", topics: ["marine biology"] },
  ],
};
const profiles = [
  {
    name: "Sylvia Earle",
    profileUrl: "https://www.instagram.com/sylvia.earle",
    platform: "Instagram",
    description: "Marine biologist and ocean explorer.",
  },
];

it("researches any Brain niche and only displays names backed by matching public profiles", async () => {
  const generate = vi.fn().mockResolvedValue(plan);
  const searchProfiles = vi.fn().mockResolvedValue([
    ...profiles,
    {
      ...profiles[0],
      name: "Sylvia Earle fan club",
      profileUrl: "https://www.instagram.com/fanclub",
    },
  ]);
  const result = await researchDiscoverContext(context, { generate, searchProfiles });
  expect(result.research?.topics).toEqual(plan.topics);
  expect(result.research?.creators.map((creator) => creator.name)).toEqual(["Sylvia Earle"]);
  expect(searchProfiles).toHaveBeenCalledWith(
    expect.objectContaining({ name: "Sylvia Earle", language: "en", region: "in" }),
  );
  expect(generate).toHaveBeenCalledWith(
    expect.objectContaining({
      brain: [expect.objectContaining({ content: context.brainItems[0].content })],
    }),
    expect.objectContaining({ timeoutMs: 8_000, signal: expect.any(AbortSignal) }),
  );
});

afterEach(() => vi.useRealTimers());

it("reuses expired matching research on cached reads and after a transient provider failure", async () => {
  const first = await researchDiscoverContext(context, {
    generate: async () => plan,
    searchProfiles: async () => profiles,
    now: () => 1,
  });
  const generate = vi.fn().mockRejectedValue(new Error("upstream temporarily unavailable"));
  const searchProfiles = vi.fn();
  const deps = { generate, searchProfiles, now: () => 30 * 86_400_000 };
  const read = await researchDiscoverContext(context, deps, first.cache, false);
  expect(read.research?.creators[0].name).toBe("Sylvia Earle");
  expect(generate).not.toHaveBeenCalled();
  const refresh = await researchDiscoverContext(context, deps, first.cache, true);
  expect(refresh.research?.topics).toEqual(plan.topics);
  expect(refresh.research?.creators[0].name).toBe("Sylvia Earle");
  expect(refresh.cache).toBeUndefined();
  expect(refresh.warnings?.length).toBeGreaterThan(0);
});

it("bounds the entire research operation and cancels slow profile searches", async () => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  const searchProfiles = vi.fn(({ signal }) => {
    signals.push(signal);
    return new Promise<never>(() => {});
  });
  const pending = researchDiscoverContext(context, { generate: async () => plan, searchProfiles });
  // The cache digest uses native crypto; let it finish before advancing fake timers.
  await vi.waitFor(() => expect(searchProfiles).toHaveBeenCalled(), { interval: 1 });
  await vi.advanceTimersByTimeAsync(12_000);
  const result = await pending;
  expect(result.research?.topics).toEqual(plan.topics);
  expect(result.warnings?.length).toBeGreaterThan(0);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});

it("does not include suggested Brain notes or opted-out Brain data in research", () => {
  expect(discoverResearchInput({ ...context, useBrainContext: false }).brain).toEqual([]);
  expect(
    discoverResearchInput({
      ...context,
      brainItems: [{ ...context.brainItems[0], status: "suggested" }],
    }).brain,
  ).toEqual([]);
});

it("reuses a matching private cache, invalidates it when the Brain changes, and performs no research on reads", async () => {
  const generate = vi.fn().mockResolvedValue(plan);
  const searchProfiles = vi.fn().mockResolvedValue(profiles);
  const deps = { generate, searchProfiles };
  const first = await researchDiscoverContext(context, deps);
  expect(first.cache).toBeDefined();
  generate.mockClear();
  searchProfiles.mockClear();
  const cached = await researchDiscoverContext(context, deps, first.cache, false);
  expect(cached.research?.creators[0].name).toBe("Sylvia Earle");
  expect(generate).not.toHaveBeenCalled();
  const changed = {
    ...context,
    brainItems: [{ ...context.brainItems[0], content: "I create comedy." }],
  };
  expect(
    (await researchDiscoverContext(changed, deps, first.cache, false)).research,
  ).toBeUndefined();
  expect(
    (
      await researchDiscoverContext(
        { ...context, useBrainContext: false },
        deps,
        first.cache,
        false,
      )
    ).research,
  ).toBeUndefined();
  expect(generate).not.toHaveBeenCalled();
  await researchDiscoverContext(changed, deps, first.cache);
  expect(generate).toHaveBeenCalledTimes(1);
});

it("keeps topic research when profile search fails and degrades gracefully when AI fails", async () => {
  const result = await researchDiscoverContext(context, {
    generate: async () => plan,
    searchProfiles: async () => {
      throw new Error("unavailable");
    },
  });
  expect(result.research?.topics).toEqual(plan.topics);
  expect(result.research?.creators).toEqual([]);
  expect(result.warnings?.length).toBeGreaterThan(0);
  const failed = await researchDiscoverContext(context, {
    generate: async () => {
      throw new Error("unavailable");
    },
    searchProfiles: vi.fn(),
  });
  expect(failed.research).toBeUndefined();
  expect(failed.warnings?.length).toBeGreaterThan(0);
});
