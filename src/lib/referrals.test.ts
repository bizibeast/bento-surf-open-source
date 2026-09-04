import { describe, expect, it } from "vitest";
import {
  commissionAmount,
  canonicalReachPostUrl,
  isReferralCode,
  reachPostFromUrl,
  reachRewardAmount,
  referralRefundReversal,
} from "./referrals";

describe("referral financial rules", () => {
  it("validates lowercase, non-reserved referral codes", () => {
    expect(isReferralCode("maya-creates")).toBe(true);
    expect(isReferralCode("Signup")).toBe(false);
    expect(isReferralCode("admin")).toBe(false);
    expect(isReferralCode("https://bad.example")).toBe(false);
  });

  it("calculates commission from pre-tax minor units", () => {
    expect(commissionAmount(10_000, 1_800, 2_000)).toBe(1_640);
  });

  it("caps proportional refund reversals at the remaining commission", () => {
    expect(referralRefundReversal(2_000, 0, 2_500, 10_000)).toBe(500);
    expect(referralRefundReversal(2_000, 1_700, 10_000, 10_000)).toBe(300);
  });

  it("uses launch reach rates and the per-post cap", () => {
    expect(reachRewardAmount("linkedin", 25_000)).toBe(6_250);
    expect(reachRewardAmount("instagram", 2_000_000)).toBe(50_000);
    expect(reachRewardAmount("youtube", 50_000)).toBeNull();
  });

  it("accepts only canonical posts from the selected connected provider", () => {
    expect(
      canonicalReachPostUrl("https://www.instagram.com/reel/ABC/?utm_source=share", "instagram"),
    ).toBe("https://instagram.com/reel/ABC");
    expect(canonicalReachPostUrl("https://evil.example/reel/ABC", "instagram")).toBeNull();
    expect(canonicalReachPostUrl("https://x.com/creator", "twitter")).toBeNull();
  });

  it("detects the platform directly from a published post URL", () => {
    expect(reachPostFromUrl("https://www.threads.net/@creator/post/ABC?share=1")).toEqual({
      provider: "threads",
      canonicalUrl: "https://threads.net/@creator/post/ABC",
    });
    expect(reachPostFromUrl("https://example.com/post/ABC")).toBeNull();
  });
});
