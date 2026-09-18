import { fireEvent, render, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes } from "react";
import { describe, expect, it, vi } from "vitest";
import type { SocialAnalyticsAccount } from "@/lib/social-analytics.functions";
import type { SocialContentInsight } from "@/lib/social-content-insights.server";
import { ActivityHeatmap, InsightsDashboard } from "./social-insights";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props} />
  ),
}));

const account: SocialAnalyticsAccount = {
  connectionId: "instagram:creator",
  provider: "instagram",
  handle: "creator",
  displayName: "Creator",
  avatarUrl: null,
  followers: 1_200,
  following: 50,
  posts: 40,
  views: 8_000,
  reach: 6_000,
  engagements: 900,
  status: "available",
  note: null,
  fetchedAt: "2026-09-05T12:00:00.000Z",
  refreshing: false,
  refreshStartedAt: null,
};

describe("Social Insights totals", () => {
  it("starts with explicitly labeled totals across connected platforms", () => {
    render(
      <InsightsDashboard
        accounts={[account]}
        history={[]}
        content={[]}
        selectedId={null}
        onSelect={vi.fn()}
        refreshing={false}
        onRefresh={vi.fn()}
        displayPeriodDays={30}
        savingDisplayPeriod={false}
        onDisplayPeriodChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Totals across every connected platform" }),
    ).toBeVisible();
    for (const label of [
      "Total followers",
      "Total views",
      "Total reach",
      "Total engagements",
      "Total posts",
    ]) {
      expect(screen.getByText(label)).toBeVisible();
    }
    expect(screen.getByText("1 connected account")).toBeVisible();
  });

  it("shows every platform and post attached to a hovered heatmap day", async () => {
    const content = (
      provider: SocialContentInsight["provider"],
      connectionId: string,
      remotePostId: string,
      caption: string,
    ): SocialContentInsight => ({
      connectionId,
      provider,
      remotePostId,
      remotePostUrl: null,
      contentType: "video",
      caption,
      thumbnailUrl: null,
      publishedAt: "2026-09-05T10:00:00.000Z",
      views: 100,
      impressions: null,
      reach: 80,
      engagements: 10,
      likes: 8,
      comments: 1,
      shares: 1,
      saves: null,
      fetchedAt: "2026-09-05T12:00:00.000Z",
    });

    render(
      <ActivityHeatmap
        account={account}
        now={new Date("2026-09-05T12:00:00.000Z")}
        content={[
          content("instagram", account.connectionId, "instagram-post", "Instagram launch"),
          content("youtube", "youtube:creator", "youtube-post", "YouTube deep dive"),
        ]}
      />,
    );

    const activityDay = screen.getByRole("button", {
      name: /2 posts across Instagram and YouTube/,
    });
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.focus(activityDay);
    expect((await screen.findAllByText("Instagram launch"))[0]).toBeVisible();
    expect(screen.getAllByText("YouTube deep dive")[0]).toBeVisible();
    expect(screen.getAllByLabelText("Instagram post")[0]).toBeVisible();
    expect(screen.getAllByLabelText("YouTube post")[0]).toBeVisible();
  });
});
