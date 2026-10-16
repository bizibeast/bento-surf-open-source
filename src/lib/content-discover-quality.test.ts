import { describe, expect, it } from "vitest";
import { evaluateDiscoverQuality } from "./content-discover-quality";

const now = Date.parse("2026-10-11T12:00:00Z");
const source = {
  platform: "YouTube",
  publishedAt: "2026-10-10T12:00:00Z",
  stats: { followers: 1_000, views: 10_000 },
};

describe("Discover observed quality gate", () => {
  it.each(["YouTube", "Instagram", "LinkedIn", "TikTok", "X", "Twitter", "Threads", "Facebook"])(
    "admits a recent %s post at the audience and observed views boundary",
    (platform) => expect(evaluateDiscoverQuality({ ...source, platform }, now).eligible).toBe(true),
  );

  it("accepts observed likes without requiring an unavailable view count", () => {
    expect(
      evaluateDiscoverQuality({ ...source, stats: { followers: 1_000, likes: 100 } }, now),
    ).toMatchObject({ eligible: true, evidence: { views: null, likes: 100 } });
  });

  it("rejects tiny audiences even when posts have huge views or come from a tracked celebrity", () => {
    const famous = {
      ...source,
      followed: true,
      established: true,
      stats: { followers: 5, views: 9_000_000, likes: 100_000 },
    };
    expect(evaluateDiscoverQuality(famous, now)).toMatchObject({
      eligible: false,
      reason: "audience_too_small",
    });
  });

  it("preserves the distinction between unavailable followers and an observed zero", () => {
    expect(evaluateDiscoverQuality({ ...source, stats: { views: 50_000 } }, now)).toMatchObject({
      eligible: false,
      reason: "followers_unknown",
      evidence: { followers: null },
    });
    expect(
      evaluateDiscoverQuality({ ...source, stats: { followers: 0, views: 50_000 } }, now),
    ).toMatchObject({ eligible: false, reason: "audience_too_small", evidence: { followers: 0 } });
  });

  it("requires a real post-performance observation even for a large audience", () => {
    expect(
      evaluateDiscoverQuality({ ...source, stats: { followers: 9_000_000 } }, now),
    ).toMatchObject({ eligible: false, reason: "traction_unknown" });
    expect(
      evaluateDiscoverQuality(
        { ...source, stats: { followers: 9_000_000, views: 0, likes: 0 } },
        now,
      ),
    ).toMatchObject({
      eligible: false,
      reason: "traction_too_low",
      evidence: { views: 0, likes: 0 },
    });
  });

  it.each([null, undefined, NaN, Infinity, -1])(
    "does not accept invalid follower observations (%s)",
    (followers) => {
      expect(
        evaluateDiscoverQuality({ ...source, stats: { followers, views: 50_000 } }, now).eligible,
      ).toBe(false);
    },
  );

  it.each([
    [null, "publication_unknown"],
    ["invalid", "publication_unknown"],
    ["2023-10-10T12:00:00Z", "publication_stale"],
    ["2026-10-11T12:00:01Z", "publication_future"],
  ])("rejects unverified, stale and future publication dates (%s)", (publishedAt, reason) => {
    expect(evaluateDiscoverQuality({ ...source, publishedAt }, now)).toMatchObject({
      eligible: false,
      reason,
    });
  });

  it("accepts exactly 30 days and recommendation-shaped source dates", () => {
    const { publishedAt: _publishedAt, ...recommendation } = source;
    expect(
      evaluateDiscoverQuality({ ...recommendation, sourcePublishedAt: "2026-09-11T12:00:00Z" }, now)
        .eligible,
    ).toBe(true);
    expect(
      evaluateDiscoverQuality({ ...recommendation, sourcePublishedAt: "2026-09-11T11:59:59Z" }, now)
        .eligible,
    ).toBe(false);
  });

  it.each([
    ["Reddit", 100],
    ["Hacker News", 50],
    ["hackernews", 50],
  ])("uses observed votes and conversation instead of followers for %s", (platform, votes) => {
    expect(
      evaluateDiscoverQuality({ ...source, platform, stats: { likes: votes, comments: 10 } }, now)
        .eligible,
    ).toBe(true);
    expect(
      evaluateDiscoverQuality(
        { ...source, platform, stats: { likes: votes - 1, comments: 10 } },
        now,
      ).eligible,
    ).toBe(false);
    expect(
      evaluateDiscoverQuality({ ...source, platform, stats: { likes: votes, comments: 9 } }, now)
        .eligible,
    ).toBe(false);
    expect(
      evaluateDiscoverQuality({ ...source, platform, stats: { likes: votes } }, now).reason,
    ).toBe("traction_unknown");
  });

  it("does not invent a quality standard for unknown source types", () => {
    expect(evaluateDiscoverQuality({ ...source, platform: "Web" }, now).reason).toBe(
      "unsupported_platform",
    );
  });
});
