import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
import { InsightsDashboard } from "./social-insights";
import type { SocialAnalyticsAccount } from "@/lib/social-analytics.functions";
import type { SocialContentInsight } from "@/lib/social-content-insights.server";
const accounts = ["instagram", "facebook"].map((provider) => ({
  connectionId: provider,
  provider,
  handle: provider,
  displayName: provider,
  avatarUrl: null,
  followers: 10,
  following: null,
  posts: 1,
  views: 100,
  reach: 50,
  engagements: 2,
  status: "available",
  note: null,
  fetchedAt: new Date().toISOString(),
  lastUpdatedAt: "2026-09-20T00:00:00.000Z",
  nextRefreshAt: "2026-09-20T20:30:00.000Z",
  initialImportActive: false,
  refreshing: false,
  refreshStartedAt: null,
})) as SocialAnalyticsAccount[];
const content = accounts.map((a) => ({
  connectionId: a.connectionId,
  provider: a.provider,
  remotePostId: "same-id",
  remotePostUrl: null,
  contentType: "text",
  caption: null,
  thumbnailUrl: null,
  publishedAt: new Date().toISOString(),
  views: 100,
  impressions: null,
  reach: 50,
  engagements: 2,
  likes: 1,
  comments: 1,
  shares: null,
  saves: null,
  fetchedAt: new Date().toISOString(),
})) as SocialContentInsight[];
it("switches between combined and isolated account heatmaps", () => {
  function Harness() {
    const [selectedId, onSelect] = useState("all");
    return (
      <InsightsDashboard
        accounts={accounts}
        content={content}
        history={[]}
        selectedId={selectedId}
        onSelect={onSelect}
        refreshing={false}
        onRefresh={() => {}}
        displayPeriodDays={30}
        savingDisplayPeriod={false}
        onDisplayPeriodChange={() => {}}
      />
    );
  }
  render(<Harness />);
  expect(screen.getByRole("heading", { name: "2 posts" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Instagram.*@instagram/ }));
  expect(screen.getByRole("heading", { name: "1 post" })).toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: "All social media" }));
  expect(screen.getByRole("heading", { name: "2 posts" })).toBeVisible();
});

it("treats reported zero views as data instead of missing history", () => {
  render(
    <InsightsDashboard
      accounts={accounts}
      content={content.map((item) => ({ ...item, views: 0 }))}
      history={[]}
      selectedId="instagram"
      onSelect={() => {}}
      refreshing={false}
      onRefresh={() => {}}
      displayPeriodDays={30}
      savingDisplayPeriod={false}
      onDisplayPeriodChange={() => {}}
    />,
  );
  expect(screen.queryByText("No historical views yet")).not.toBeInTheDocument();
});

it("keeps LinkedIn visible while analytics access is coming soon", () => {
  render(
    <InsightsDashboard
      accounts={[
        {
          ...accounts[0],
          connectionId: "linkedin",
          provider: "linkedin",
          handle: "bento",
          followers: null,
          views: null,
          reach: null,
          engagements: null,
          status: "unavailable",
        },
      ]}
      content={[]}
      history={[]}
      selectedId="linkedin"
      onSelect={() => {}}
      refreshing={false}
      onRefresh={() => {}}
      displayPeriodDays={30}
      savingDisplayPeriod={false}
      onDisplayPeriodChange={() => {}}
    />,
  );

  expect(screen.getByRole("heading", { name: "LinkedIn analytics coming soon" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Growth" })).not.toBeInTheDocument();
});

it("shows daily freshness without offering a manual provider refresh", () => {
  render(
    <InsightsDashboard
      accounts={accounts}
      content={content}
      history={[]}
      selectedId="instagram"
      onSelect={() => {}}
      refreshing={false}
      onRefresh={() => {}}
      displayPeriodDays={30}
      savingDisplayPeriod={false}
      onDisplayPeriodChange={() => {}}
    />,
  );

  expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  expect(screen.getByText("Updated every 24 hours")).toBeVisible();
  expect(screen.getByText(/Last updated Sep 20, 2026/i)).toBeVisible();
});

it("shows the import state only during first-time setup and preserves error metrics", () => {
  const { rerender } = render(
    <InsightsDashboard
      accounts={[{ ...accounts[0], refreshing: true, initialImportActive: true }]}
      content={[]}
      history={[]}
      selectedId="instagram"
      onSelect={() => {}}
      refreshing
      onRefresh={() => {}}
      displayPeriodDays={30}
      savingDisplayPeriod={false}
      onDisplayPeriodChange={() => {}}
    />,
  );
  expect(screen.getByRole("heading", { name: "We’re importing your data" })).toBeVisible();

  rerender(
    <InsightsDashboard
      accounts={[
        {
          ...accounts[0],
          refreshing: true,
          initialImportActive: false,
          status: "error",
          note: "Reconnect Instagram to resume daily updates.",
        },
      ]}
      content={content.slice(0, 1)}
      history={[]}
      selectedId="instagram"
      onSelect={() => {}}
      refreshing
      onRefresh={() => {}}
      displayPeriodDays={30}
      savingDisplayPeriod={false}
      onDisplayPeriodChange={() => {}}
    />,
  );
  expect(screen.queryByRole("heading", { name: "We’re importing your data" })).toBeNull();
  expect(screen.getAllByText("Reconnect Instagram to resume daily updates.")[0]).toBeVisible();
  expect(screen.getAllByText("Followers")[0]).toBeVisible();
});
