import { expect, it, vi } from "vitest";
import { generateOnboardingDrafts } from "./generation.server";
import { onboardingBriefSchema, buildManualCandidates, onboardingCandidatesSchema } from "./brief";
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
it("generates three supported drafts and compares all accepted carousel slide text", async () => {
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
  expect(output.drafts).toHaveLength(3);
  expect(output.brain).toEqual(candidates.brain);
  expect(generate.mock.calls[0][0]).toMatchObject({ platform: "instagram", format: "carousel" });
  expect(generate.mock.calls[2][0].recentOutputs).toHaveLength(2);
  expect(
    generate.mock.calls[2][0].recentOutputs.map((post: { body: string }) => post.body).join(" "),
  ).toContain("Specific explanation 1");
  expect(generate.mock.calls[0][0].sources).toEqual(
    expect.arrayContaining([expect.objectContaining({ occurredAt: "2024-01-01" })]),
  );
  expect(generate.mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(45000);
});
it("keeps completed drafts and distinguishes transient failures from missing evidence", async () => {
  const brief = onboardingBriefSchema.parse({ platform: "instagram" });
  for (const status of ["retry", "needs_input"] as const) {
    const generate = vi
      .fn()
      .mockResolvedValueOnce(ready(1))
      .mockResolvedValue({
        status,
        message: status === "retry" ? "Provider unavailable; retry." : "Add an original example.",
        issues: [],
        card: { type: "idea" },
      });
    const result = await generateOnboardingDrafts(
      brief,
      buildManualCandidates(brief),
      [],
      generate,
    );
    expect(result.drafts).toHaveLength(1);
    expect(result).toHaveProperty("retry", status === "retry");
    expect(generate).toHaveBeenCalledTimes(2);
  }
});
it("does no generation after the shared deadline", async () => {
  const brief = onboardingBriefSchema.parse({});
  const generate = vi.fn();
  const result = await generateOnboardingDrafts(
    brief,
    buildManualCandidates(brief),
    [],
    generate,
    Date.now() - 1,
  );
  expect(generate).not.toHaveBeenCalled();
  expect(result.warning).toMatch(/timed out/);
});

it("retains creator-edited partial drafts on retry and compares their complete slides before filling missing slots", async () => {
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
  expect(result.drafts).toHaveLength(3);
  expect(generate).toHaveBeenCalledTimes(2);
  expect(generate.mock.calls[0][0].recentOutputs[0].body).toContain(
    "Creator's complete slide argument",
  );
  expect(generate.mock.calls[0][1].timeoutMs).toBe(45000);
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
  expect(generate).toHaveBeenCalledTimes(3);
  expect(generate.mock.calls[0][0].recentOutputs).toHaveLength(3);
});
