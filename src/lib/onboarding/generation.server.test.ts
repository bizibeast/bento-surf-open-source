import { expect, it, vi } from "vitest";
import {
  citedInstagramPhoto,
  generateOnboardingDrafts,
  groundedOnboardingDraft,
} from "./generation.server";
import { onboardingBriefSchema, buildManualCandidates, onboardingCandidatesSchema } from "./brief";

it("only attaches a cited Instagram image with stable caption-filtered source IDs", () => {
  const sources = [
    {
      id: "empty",
      provider: "instagram",
      caption: null,
      content_type: "image",
      remote_post_url: null,
    },
    {
      id: "video",
      provider: "instagram",
      caption: "A video",
      content_type: "video",
      remote_post_url: null,
    },
    {
      id: "photo",
      provider: "instagram",
      caption: "An owned photo story",
      content_type: "carousel",
      remote_post_url: null,
    },
  ];
  const draft = {
    title: "Lesson",
    body: "Lesson",
    platform: "linkedin" as const,
    editorial: {
      sourceIds: ["source-1"],
      angle: "Lesson",
      whyNow: "Useful",
      validationState: "passed" as const,
    },
  };
  expect(citedInstagramPhoto(draft, sources)).toBe("photo");
  expect(
    citedInstagramPhoto(
      { ...draft, editorial: { ...draft.editorial, sourceIds: ["source-0"] } },
      sources,
    ),
  ).toBeUndefined();
  expect(citedInstagramPhoto({ ...draft, platform: "twitter" }, sources)).toBeUndefined();
});
it("keeps the selected photo story in a crowded evidence pack without reindexing sources", async () => {
  const brief = onboardingBriefSchema.parse({ platform: "linkedin" });
  const sources = Array.from({ length: 24 }, (_, index) => ({
    id: `post-${index}`,
    provider: "instagram",
    caption: `Supported story ${index}`,
    content_type: "image",
    remote_post_url: null,
  }));
  const generate = vi.fn().mockResolvedValue({
    status: "needs_input",
    message: "Fixture",
    card: { type: "idea" },
    issues: [],
  });
  await generateOnboardingDrafts(
    brief,
    buildManualCandidates(brief),
    sources,
    generate,
    Date.now() + 90000,
    false,
    "post-23",
  );
  expect(generate.mock.calls[0][0].sourceIds).toContain("source-23");
  expect(generate.mock.calls[0][0].request).toContain("from source-23");
});

it("requires a supported output while retaining an imported video source brief", async () => {
  const brief = onboardingBriefSchema.parse({ platform: "youtube" });
  const result = await generateOnboardingDrafts(brief, buildManualCandidates(brief), []);
  expect(result.drafts).toEqual([]);
  expect(result.warning).toMatch(/choose.*X.*LinkedIn.*Instagram/i);
  expect(brief.platform).toBe("youtube");
});
it("preserves legacy candidates and structured carousel slides", () => {
  const base = buildManualCandidates(onboardingBriefSchema.parse({}));
  expect(
    onboardingCandidatesSchema.parse({ ...base, drafts: [{ title: "Old", body: "Saved script" }] })
      .drafts[0].body,
  ).toBe("Saved script");
  const slides = [{ heading: "Choose", body: "Compare the tradeoffs" }];
  expect(
    onboardingCandidatesSchema.parse({
      ...base,
      drafts: [
        { title: "New", body: "Caption", platform: "instagram", format: "carousel", slides },
      ],
    }).drafts[0],
  ).toHaveProperty("slides", slides);
});

import type { EditorialGenerationResult } from "../content-editorial.server";
const ready = (index: number): EditorialGenerationResult => ({
  status: "ready",
  message: "Ready",
  issues: [],
  card: {
    type: "draft",
    cardId: `draft-${index}`,
    title: `Lesson ${index}`,
    body: `Caption ${index}`,
    platform: "instagram",
    format: "carousel",
    sourceUrls: [],
    visualBrief: null,
    rationale: "A supported lesson",
    slides: [
      { heading: `Decision ${index}`, body: `Specific explanation ${index}` },
      { heading: `Tradeoff ${index}`, body: `Limitation ${index}` },
    ],
    editorial: {
      sourceIds: ["profile-0"],
      angle: "A specific decision",
      whyNow: "A useful starting point",
      validationState: "passed",
    },
  },
});
it("generates one checked starter draft and preserves source dates", async () => {
  const brief = onboardingBriefSchema.parse({
    platform: "instagram",
    expertise: "Coral restoration",
    audience: "Divers",
  });
  const generate = vi
    .fn()
    .mockResolvedValueOnce(ready(1))
    .mockResolvedValueOnce(ready(2))
    .mockResolvedValueOnce(ready(3));
  const candidates = buildManualCandidates(brief);
  const output = await generateOnboardingDrafts(
    brief,
    candidates,
    [
      {
        provider: "youtube",
        caption: "My old reef demonstration",
        remote_post_url: "https://example.com/reef",
        published_at: "2024-01-01",
      },
    ],
    generate,
  );
  expect(output.drafts).toHaveLength(1);
  expect(generate).toHaveBeenCalledOnce();
  expect(output.brain).toEqual(candidates.brain);
  expect(generate.mock.calls[0][0]).toMatchObject({ platform: "instagram", format: "carousel" });
  expect(generate.mock.calls[0][0].sources).toEqual(
    expect.arrayContaining([expect.objectContaining({ occurredAt: "2024-01-01" })]),
  );
  expect(generate.mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(80_000);
  expect(generate.mock.calls[0][1].timeoutMs).toBeGreaterThan(45_000);
});
it("retries a transient failure once, then keeps an answer-only starter", async () => {
  const brief = onboardingBriefSchema.parse({
    platform: "linkedin",
    expertise: "Coral restoration",
    audience: "Divers",
  });
  const generate = vi.fn().mockResolvedValue({
    status: "retry",
    reason: "timeout",
    message: "Provider unavailable; retry.",
    issues: [],
    card: { type: "idea" },
  });
  const result = await generateOnboardingDrafts(
    brief,
    buildManualCandidates(brief),
    [],
    generate,
    Date.now() + 90_000,
    true,
    null,
    0,
  );
  expect(generate).toHaveBeenCalledTimes(2);
  expect(result.retry).toBe(false);
  expect(result.drafts).toHaveLength(1);
  expect(result.drafts[0].body).toContain("Coral restoration");
  expect(result.drafts[0].body).toContain("Divers");
  expect(result.warning).toMatch(/answers you already gave/);
  expect(JSON.stringify(result.drafts)).not.toMatch(/\u2014|\d+%|\$\d|million/);
});
it("does not spend a second model call when evidence is missing", async () => {
  const brief = onboardingBriefSchema.parse({
    platform: "linkedin",
    expertise: "Coral restoration",
    audience: "Divers",
  });
  const generate = vi.fn().mockResolvedValue({
    status: "needs_input",
    reason: "evidence",
    message: "Add an original example.",
    issues: [],
    card: { type: "idea" },
  });
  const result = await generateOnboardingDrafts(brief, buildManualCandidates(brief), [], generate);
  expect(generate).toHaveBeenCalledOnce();
  expect(result.drafts[0].body).toContain("Coral restoration");
  expect(result.warning).toMatch(/without adding facts/);
});
it("builds an answer-only starter inside provider limits", () => {
  const twitter = groundedOnboardingDraft(
    onboardingBriefSchema.parse({
      platform: "twitter",
      expertise: "x".repeat(400),
      audience: "y".repeat(400),
      offer: "A workshop I already teach",
    }),
  );
  expect(twitter.platform).toBe("twitter");
  expect(twitter.format).toBe("post");
  expect(twitter.body.length).toBeLessThanOrEqual(280);
  expect(twitter.body).toContain("xxxx");
  const withOffer = groundedOnboardingDraft(
    onboardingBriefSchema.parse({
      platform: "twitter",
      expertise: "Reef care",
      audience: "Divers",
      offer: "A workshop I already teach",
    }),
  );
  expect(withOffer.body).toContain("workshop");
  expect(withOffer.body.length).toBeLessThanOrEqual(280);
  const instagram = groundedOnboardingDraft(
    onboardingBriefSchema.parse({
      platform: "instagram",
      expertise: "Reef care",
      audience: "New divers",
    }),
  );
  expect(instagram.format).toBe("carousel");
  expect(instagram.slides?.length).toBeGreaterThanOrEqual(2);
  expect(JSON.stringify(instagram)).not.toMatch(/\u2014/);
});
it("does no generation after the shared deadline and still leaves a starter", async () => {
  const brief = onboardingBriefSchema.parse({ expertise: "Reef care", audience: "Divers" });
  const generate = vi.fn();
  const result = await generateOnboardingDrafts(
    brief,
    buildManualCandidates(brief),
    [],
    generate,
    Date.now() - 1,
  );
  expect(generate).not.toHaveBeenCalled();
  expect(result.warning).toMatch(/ran out of time/);
  expect(result.drafts[0].body).toContain("Reef care");
});

it("retains a creator-edited draft on retry without generating another starter", async () => {
  const brief = onboardingBriefSchema.parse({ platform: "instagram" });
  const completed = ready(1).card;
  if (completed.type !== "draft") throw new Error("fixture");
  const edited = {
    ...completed,
    body: "Creator edited caption",
    slides: [
      { heading: "Edited tradeoff", body: "Creator's complete slide argument" },
      { heading: "Reader decision", body: "Creator edited conclusion" },
    ],
  };
  const candidates = onboardingCandidatesSchema.parse({
    ...buildManualCandidates(brief),
    drafts: [edited],
  });
  const generate = vi.fn().mockResolvedValueOnce(ready(2)).mockResolvedValueOnce(ready(3));
  const result = await generateOnboardingDrafts(brief, candidates, [], generate);
  expect(result.drafts[0]).toEqual(candidates.drafts[0]);
  expect(result.drafts).toHaveLength(1);
  expect(generate).not.toHaveBeenCalled();
});
it("only replaces a completed starter batch on explicit refresh and still compares old copy", async () => {
  const brief = onboardingBriefSchema.parse({ platform: "instagram" });
  const candidates = onboardingCandidatesSchema.parse({
    ...buildManualCandidates(brief),
    drafts: [ready(1).card, ready(2).card, ready(3).card],
  });
  const generate = vi.fn().mockResolvedValue(ready(4));
  const retained = await generateOnboardingDrafts(brief, candidates, [], generate);
  expect(retained.drafts).toEqual(candidates.drafts);
  expect(generate).not.toHaveBeenCalled();
  await generateOnboardingDrafts(brief, candidates, [], generate, Date.now() + 90000, false);
  expect(generate).toHaveBeenCalledOnce();
  expect(generate.mock.calls[0][0].recentOutputs).toHaveLength(3);
});
