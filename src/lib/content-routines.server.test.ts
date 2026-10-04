import { describe, expect, it, vi } from "vitest";
import {
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
    expect(deps.generateCustomRoutine).toHaveBeenCalledWith({
      userId: "creator",
      instructions: "Write a sourced weekly plan.",
      platforms: ["linkedin"],
    });
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
