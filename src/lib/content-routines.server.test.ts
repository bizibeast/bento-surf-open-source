import { describe, expect, it, vi } from "vitest";
import {
  prepareRoutineDrafts,
  prepareRoutineReview,
  processContentRoutineRun,
  processDueContentRoutines,
  type ContentRoutineRun,
  type ContentRoutineServerDependencies,
} from "./content-routines.server";

const run: ContentRoutineRun = {
  id: "run",
  routineId: "routine",
  userId: "creator",
  template: "fill_schedule",
  scheduledFor: "2026-09-17T20:30:00.000Z",
  timezone: "UTC",
  schedule: { intervalMinutes: 1_440, time: "03:00" },
  platforms: ["linkedin"],
};

function dependencies(): ContentRoutineServerDependencies {
  return {
    claimRuns: vi.fn().mockResolvedValue([run]),
    loadContext: vi.fn().mockResolvedValue({
      profile: { nicheKeywords: ["creator AI"], language: "en", region: "global" },
      postingSchedule: {
        timezone: "UTC",
        naturalOffset: false,
        slots: [{ day: 5, time: "09:00" }],
      },
      posts: [],
    }),
    refreshBrief: vi.fn().mockResolvedValue({ items: [{ title: "News" }] }),
    generateDraftBatch: vi.fn().mockResolvedValue(1),
    generateWeeklyReview: vi.fn().mockResolvedValue(1),
    finishRun: vi.fn().mockResolvedValue(true),
    cleanupExpiredMessages: vi.fn().mockResolvedValue(undefined),
    syncKnowledge: vi.fn().mockResolvedValue({ succeeded: 1, failed: 0 }),
    notifyDraftsReady: vi.fn().mockResolvedValue(undefined),
  };
}

describe("content routine processor", () => {
  it("executes custom instructions through Agent and morning notifications at their own run time", async () => {
    const deps = dependencies();
    deps.generateCustomRoutine = vi.fn().mockResolvedValue(2);
    deps.notifyMorningDrafts = vi.fn().mockResolvedValue(3);
    await expect(
      processContentRoutineRun(
        {
          ...run,
          template: "custom:11111111-1111-4111-8111-111111111111",
          schedule: { ...run.schedule, instructions: "Write a sourced weekly plan." },
        },
        deps,
      ),
    ).resolves.toEqual({ resultCount: 2 });
    expect(deps.generateCustomRoutine).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "creator",
        instructions: "Write a sourced weekly plan.",
        platforms: ["linkedin"],
      }),
    );
    await expect(
      processContentRoutineRun({ ...run, template: "morning_ready_email" }, deps),
    ).resolves.toEqual({ resultCount: 3 });
    expect(deps.notifyMorningDrafts).toHaveBeenCalledOnce();
  });
  it("creates only the missing draft quantity for Fill my schedule", async () => {
    const deps = dependencies();
    const result = await processContentRoutineRun(run, deps);
    expect(deps.syncKnowledge).toHaveBeenCalledWith("creator");
    expect(deps.generateDraftBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "creator",
        platforms: ["linkedin"],
        slots: [expect.objectContaining({ scheduledAt: "2026-09-18T09:00:00.000Z" })],
      }),
    );
    expect(result).toEqual({ resultCount: 1 });
    await processDueContentRoutines(deps);
    expect(deps.notifyDraftsReady).not.toHaveBeenCalled();
  });

  it("does not spend on drafts when the configured schedule is full", async () => {
    const deps = dependencies();
    const context = await deps.loadContext("creator");
    context.posts = [
      { id: "occupied", status: "scheduled", scheduledAt: "2026-09-18T09:00:00.000Z" } as any,
    ];
    vi.mocked(deps.loadContext).mockResolvedValue(context);
    expect(await processContentRoutineRun(run, deps)).toEqual({ resultCount: 0 });
    expect(deps.refreshBrief).not.toHaveBeenCalled();
    expect(deps.generateDraftBatch).not.toHaveBeenCalled();
  });

  it("caps unreviewed draft backlogs before refreshing paid sources", async () => {
    const deps = dependencies();
    const context = await deps.loadContext("creator");
    context.posts = Array.from(
      { length: 9 },
      (_, i) => ({ id: String(i), status: "draft" }) as any,
    );
    vi.mocked(deps.loadContext).mockResolvedValue(context);
    expect(await processContentRoutineRun(run, deps)).toEqual({ resultCount: 0 });
    expect(deps.refreshBrief).not.toHaveBeenCalled();
    expect(deps.generateDraftBatch).not.toHaveBeenCalled();
  });

  it("isolates a failed creator and continues the remaining claimed runs", async () => {
    const deps = dependencies();
    vi.mocked(deps.claimRuns).mockResolvedValue([
      run,
      { ...run, id: "run-2", routineId: "routine-2", userId: "creator-2" },
    ]);
    vi.mocked(deps.loadContext)
      .mockRejectedValueOnce(new Error("provider down"))
      .mockResolvedValueOnce({
        profile: { nicheKeywords: ["creator AI"], language: "en", region: "global" },
        postingSchedule: { timezone: "UTC", naturalOffset: false, slots: [] },
        posts: [],
      });
    const result = await processDueContentRoutines(deps);
    expect(result).toEqual({ claimed: 2, succeeded: 1, failed: 1, results: 1 });
    expect(deps.finishRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run", status: "failed", error: "provider down" }),
    );
    expect(deps.finishRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-2", status: "succeeded" }),
    );
  });

  it("does not duplicate work when the lease claim returns no run", async () => {
    const deps = dependencies();
    vi.mocked(deps.claimRuns).mockResolvedValue([]);
    expect(await processDueContentRoutines(deps)).toEqual({
      claimed: 0,
      succeeded: 0,
      failed: 0,
      results: 0,
    });
    expect(deps.generateDraftBatch).not.toHaveBeenCalled();
  });
});

it("refuses legacy schedule and video configurations before doing work", async () => {
  const deps = dependencies();
  for (const legacy of [
    { ...run, platforms: ["youtube"] },
    { ...run, schedule: { ...run.schedule, outputMode: "schedule" as const } },
  ]) {
    await expect(processContentRoutineRun(legacy, deps)).rejects.toThrow(/review/i);
  }
  expect(deps.generateDraftBatch).not.toHaveBeenCalled();
});
it("claims only one routine lease per worker tick", async () => {
  const deps = dependencies();
  await processDueContentRoutines(deps);
  expect(deps.claimRuns).toHaveBeenCalledWith(1);
});

it("uses read-only editorial context and passes complete sibling copy to the next draft", async () => {
  const card = {
    type: "draft" as const,
    cardId: "new",
    platform: "instagram" as const,
    format: "carousel" as const,
    title: "Distinct decision",
    body: "Caption",
    sourceUrls: [],
    rationale: "Supported",
    visualBrief: null,
    slides: [{ heading: "Tradeoff", body: "A complete argument on a slide" }],
  };
  const deps = {
    loadContext: vi.fn().mockResolvedValue({ brain: [], sources: [] }),
    generate: vi.fn().mockResolvedValue({ status: "ready", message: "Ready", issues: [], card }),
    save: vi.fn().mockResolvedValue(2),
  };
  await prepareRoutineDrafts(
    {
      userId: "creator",
      platforms: ["instagram"],
      slots: [{ scheduledAt: "tomorrow" }, { scheduledAt: "later" }],
      run: { ...run, platforms: ["instagram"] },
    },
    deps,
  );
  expect(deps.generate).toHaveBeenCalledTimes(2);
  expect(deps.generate.mock.calls[1][0].recentOutputs[0].body).toContain(
    "Tradeoff A complete argument on a slide",
  );
  expect(deps.save).toHaveBeenCalledWith(
    expect.objectContaining({
      runId: "run",
      userId: "creator",
      result: expect.objectContaining({ action: "draft" }),
    }),
  );
});
it("does not prepare a batch or ask for evidence on a transient editorial failure", async () => {
  const deps = {
    loadContext: vi.fn().mockResolvedValue({ brain: [], sources: [] }),
    generate: vi.fn().mockResolvedValue({
      status: "retry",
      message: "Provider unavailable; retry",
      issues: [],
      card: { type: "idea" },
    }),
    save: vi.fn(),
  };
  await expect(
    prepareRoutineDrafts({ userId: "creator", platforms: ["linkedin"], run }, deps),
  ).rejects.toThrow("Provider unavailable; retry");
  expect(deps.save).not.toHaveBeenCalled();
});

it("prepares weekly advice for cadence delivery without draft cards", async () => {
  const deps = {
    loadContext: vi.fn().mockResolvedValue({ brain: [], sources: [] }),
    loadBusiness: vi.fn().mockResolvedValue({
      salesByProduct: [{ orders: 2, productId: "product", currency: "USD" }],
    }),
    generate: vi
      .fn()
      .mockResolvedValue({ value: { message: "Review the observed results and test one offer." } }),
    save: vi.fn().mockResolvedValue(0),
  };
  expect(
    await prepareRoutineReview(
      { userId: "creator", run: { ...run, template: "weekly_performance_review" } },
      deps,
    ),
  ).toBe(1);
  expect(deps.save).toHaveBeenCalledWith(
    expect.objectContaining({
      runId: "run",
      adviceEvidence: { sourceIds: ["business:sales:product:USD"] },
      result: {
        action: "answer",
        message: "Review the observed results and test one offer.",
        cards: [],
      },
    }),
  );
  expect(deps.generate.mock.calls[0][0].timeoutMs).toBe(30000);
});

it("checks workspace entitlement before connector sync or generation", async () => {
  const deps = dependencies();
  vi.mocked(deps.loadContext).mockRejectedValue(
    new Error("Content routines are not available on this plan."),
  );
  await expect(processContentRoutineRun(run, deps)).rejects.toThrow(/not available/);
  expect(deps.syncKnowledge).not.toHaveBeenCalled();
  expect(deps.generateDraftBatch).not.toHaveBeenCalled();
  expect(deps.refreshBrief).not.toHaveBeenCalled();
});

it("checks background Agent and routine eligibility before preparation and morning delivery", async () => {
  const deps = dependencies();
  deps.authorize = vi.fn().mockRejectedValue(new Error("Inactive workspace"));
  deps.notifyMorningDrafts = vi.fn();
  await expect(processContentRoutineRun(run, deps)).rejects.toThrow("Inactive workspace");
  await expect(
    processContentRoutineRun({ ...run, template: "morning_ready_email" }, deps),
  ).rejects.toThrow("Inactive workspace");
  expect(deps.generateDraftBatch).not.toHaveBeenCalled();
  expect(deps.notifyMorningDrafts).not.toHaveBeenCalled();
});

it("saves completed drafts when a later platform exhausts its provider budget", async () => {
  const deps = {
    loadContext: vi.fn().mockResolvedValue({ brain: [], sources: [] }),
    generate: vi
      .fn()
      .mockResolvedValueOnce({
        status: "ready",
        message: "Ready",
        issues: [],
        card: {
          type: "draft",
          platform: "linkedin",
          body: "A finished grounded post.",
          slides: [],
        },
      })
      .mockResolvedValueOnce({ status: "retry", message: "Budget reached", issues: [] }),
    save: vi.fn().mockResolvedValue(1),
  };
  expect(
    await prepareRoutineDrafts(
      { userId: "creator", platforms: ["linkedin", "twitter"], run },
      deps,
    ),
  ).toBe(1);
  expect(deps.save).toHaveBeenCalledWith(
    expect.objectContaining({
      result: expect.objectContaining({
        cards: [expect.objectContaining({ body: "A finished grounded post." })],
      }),
    }),
  );
});
