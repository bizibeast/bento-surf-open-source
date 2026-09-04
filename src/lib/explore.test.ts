import { describe, expect, it } from "vitest";
import {
  EXPLORE_CATEGORIES,
  exploreCategoryLabel,
  exploreCategorySchema,
  exploreOptInStatusCopy,
  explorePreviewUrl,
  exploreReviewStatusAfterOptIn,
  isLiveOnExplore,
  isReadyForExploreReview,
  nextExploreReviewState,
  normalizeExploreSearch,
  sortExploreReviewsNewestFirst,
} from "@/lib/explore";

describe("Explore directory configuration", () => {
  it("uses stable, unique category identifiers shared with onboarding", () => {
    const identifiers = EXPLORE_CATEGORIES.map((category) => category.id);

    expect(new Set(identifiers).size).toBe(identifiers.length);
    expect(identifiers).toContain("creator");
    expect(identifiers).toContain("educator");
    expect(
      identifiers.every((identifier) => exploreCategorySchema.safeParse(identifier).success),
    ).toBe(true);
  });

  it("normalizes public search text before it reaches the directory query", () => {
    expect(normalizeExploreSearch("  @Ada <script> Lovelace!!!  ")).toBe("Ada script Lovelace");
    expect(normalizeExploreSearch("x".repeat(80))).toHaveLength(48);
  });

  it("builds encoded, cache-backed preview image paths", () => {
    expect(explorePreviewUrl("hello world")).toBe("/api/og/hello%20world.jpg");
    expect(explorePreviewUrl("hello world", "v9-preview")).toBe(
      "/api/og/hello%20world.jpg?v=v9-preview",
    );
  });

  it("falls back to a creator label for legacy values", () => {
    expect(exploreCategoryLabel("unknown")).toBe("Creator");
  });

  it("keeps previously approved listings live when a creator opts in again", () => {
    expect(exploreReviewStatusAfterOptIn("approved", 1)).toBe("approved");
    expect(exploreReviewStatusAfterOptIn("pending", 4)).toBe("pending");
    expect(exploreReviewStatusAfterOptIn("rejected", 4)).toBe("pending");
    expect(exploreReviewStatusAfterOptIn("none", 4)).toBe("pending");
    expect(exploreReviewStatusAfterOptIn("none", 3)).toBe("none");
    expect(exploreReviewStatusAfterOptIn("rejected", 2)).toBe("none");
    expect(isReadyForExploreReview(3)).toBe(false);
    expect(isReadyForExploreReview(4)).toBe(true);
    expect(isReadyForExploreReview(Number.NaN)).toBe(false);
  });

  it("only treats opted-in, founder-approved pages with enough cards as live on Explore", () => {
    expect(
      isLiveOnExplore({
        show_in_explore: true,
        explore_review_status: "approved",
        onboarded: true,
        noindex: false,
        cardCount: 4,
      }),
    ).toBe(true);
    expect(
      isLiveOnExplore({
        show_in_explore: true,
        explore_review_status: "approved",
        onboarded: true,
        noindex: false,
        cardCount: 3,
      }),
    ).toBe(false);
    expect(
      isLiveOnExplore({
        show_in_explore: true,
        explore_review_status: "pending",
        onboarded: true,
        noindex: false,
        cardCount: 8,
      }),
    ).toBe(false);
    expect(
      isLiveOnExplore({
        show_in_explore: false,
        explore_review_status: "approved",
        onboarded: true,
        noindex: false,
        cardCount: 8,
      }),
    ).toBe(false);
  });

  it("explains Explore review state to the creator", () => {
    expect(exploreOptInStatusCopy(false, "none")).toContain("more than 3 cards");
    expect(exploreOptInStatusCopy(true, "none")).toContain("more than 3 cards");
    expect(exploreOptInStatusCopy(true, "pending")).toContain("Submitted for review");
    expect(exploreOptInStatusCopy(true, "approved", 4)).toBe("Your Surf is live on Explore.");
    expect(exploreOptInStatusCopy(true, "approved", 2)).toContain("Add more than 3 cards");
    expect(exploreOptInStatusCopy(true, "rejected")).toContain("more than 3 cards");
  });
});

describe("Explore review state transitions", () => {
  const now = "2026-08-13T12:00:00.000Z";

  it("does not queue a default opt-in until the home page has more than 3 cards", () => {
    expect(
      nextExploreReviewState({
        showInExplore: true,
        wasOptedIn: false,
        status: "none",
        cardCount: 0,
        optedInAt: null,
        now,
      }),
    ).toEqual({ status: "none", optedInAt: null, clearReview: true });
    expect(
      nextExploreReviewState({
        showInExplore: true,
        wasOptedIn: true,
        status: "none",
        cardCount: 3,
        optedInAt: null,
        now,
      }),
    ).toEqual({ status: "none", optedInAt: null, clearReview: false });
  });

  it("queues the newest eligible opt-in and keeps later card adds from reshuffling it", () => {
    expect(
      nextExploreReviewState({
        showInExplore: true,
        wasOptedIn: true,
        status: "none",
        cardCount: 4,
        optedInAt: null,
        now,
      }),
    ).toEqual({ status: "pending", optedInAt: now, clearReview: false });
    expect(
      nextExploreReviewState({
        showInExplore: true,
        wasOptedIn: true,
        status: "pending",
        cardCount: 8,
        optedInAt: "2026-08-01T00:00:00.000Z",
        now,
      }),
    ).toEqual({
      status: "pending",
      optedInAt: "2026-08-01T00:00:00.000Z",
      clearReview: false,
    });
  });

  it("leaves the queue when cards drop to 3 or fewer, then re-queues on the next 4th card", () => {
    expect(
      nextExploreReviewState({
        showInExplore: true,
        wasOptedIn: true,
        status: "pending",
        cardCount: 3,
        optedInAt: now,
        now,
      }),
    ).toEqual({ status: "none", optedInAt: null, clearReview: false });
  });

  it("keeps founder approval when a live page is gutted or opted out", () => {
    expect(
      nextExploreReviewState({
        showInExplore: true,
        wasOptedIn: true,
        status: "approved",
        cardCount: 1,
        optedInAt: now,
        now,
      }),
    ).toEqual({ status: "approved", optedInAt: now, clearReview: false });
    expect(
      nextExploreReviewState({
        showInExplore: false,
        wasOptedIn: true,
        status: "approved",
        cardCount: 8,
        optedInAt: now,
        now,
      }),
    ).toEqual({ status: "approved", optedInAt: now, clearReview: false });
  });

  it("does not auto-resubmit a rejected page until the creator opts out and back in", () => {
    expect(
      nextExploreReviewState({
        showInExplore: true,
        wasOptedIn: true,
        status: "rejected",
        cardCount: 12,
        optedInAt: now,
        now,
      }),
    ).toEqual({ status: "rejected", optedInAt: now, clearReview: false });
    expect(
      nextExploreReviewState({
        showInExplore: false,
        wasOptedIn: true,
        status: "rejected",
        cardCount: 12,
        optedInAt: now,
        now,
      }),
    ).toEqual({ status: "none", optedInAt: null, clearReview: true });
    expect(
      nextExploreReviewState({
        showInExplore: true,
        wasOptedIn: false,
        status: "rejected",
        cardCount: 12,
        optedInAt: null,
        now,
      }),
    ).toEqual({ status: "pending", optedInAt: now, clearReview: true });
    expect(
      nextExploreReviewState({
        showInExplore: true,
        wasOptedIn: false,
        status: "rejected",
        cardCount: 2,
        optedInAt: null,
        now,
      }),
    ).toEqual({ status: "none", optedInAt: null, clearReview: true });
  });
});

describe("Explore review queue ordering", () => {
  it("sorts pending requests newest first and falls back to updated_at", () => {
    const rows = sortExploreReviewsNewestFirst(
      [
        {
          username: "old",
          explore_opted_in_at: "2026-08-01T00:00:00.000Z",
          explore_reviewed_at: null,
          updated_at: "2026-08-12T00:00:00.000Z",
        },
        {
          username: "new",
          explore_opted_in_at: "2026-08-10T00:00:00.000Z",
          explore_reviewed_at: null,
          updated_at: "2026-08-10T00:00:00.000Z",
        },
        {
          username: "untimed",
          explore_opted_in_at: null,
          explore_reviewed_at: null,
          updated_at: "2026-08-11T00:00:00.000Z",
        },
      ],
      "pending",
    );

    expect(rows.map((row) => row.username)).toEqual(["untimed", "new", "old"]);
  });

  it("sorts decided queues by review time, newest first", () => {
    const rows = sortExploreReviewsNewestFirst(
      [
        {
          username: "zeta",
          explore_opted_in_at: "2026-08-12T00:00:00.000Z",
          explore_reviewed_at: "2026-08-01T00:00:00.000Z",
          updated_at: "2026-08-12T00:00:00.000Z",
        },
        {
          username: "alpha",
          explore_opted_in_at: "2026-07-01T00:00:00.000Z",
          explore_reviewed_at: "2026-08-10T00:00:00.000Z",
          updated_at: "2026-08-10T00:00:00.000Z",
        },
      ],
      "live",
    );

    expect(rows.map((row) => row.username)).toEqual(["alpha", "zeta"]);
  });
});
