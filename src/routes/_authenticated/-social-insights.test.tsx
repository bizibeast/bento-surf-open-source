import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  Link: ({
    children,
    to,
    search,
    ...props
  }: React.ComponentProps<"a"> & {
    to?: string;
    search?: unknown;
  }) => (
    <a {...props} href={to} data-search={JSON.stringify(search)}>
      {children}
    </a>
  ),
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

it("shows daily freshness and offers a manual provider refresh", () => {
  const onRefresh = vi.fn();
  render(
    <InsightsDashboard
      accounts={accounts}
      content={content}
      history={[]}
      selectedId="instagram"
      onSelect={() => {}}
      refreshing={false}
      onRefresh={onRefresh}
      displayPeriodDays={30}
      savingDisplayPeriod={false}
      onDisplayPeriodChange={() => {}}
    />,
  );

  expect(screen.getByRole("button", { name: "Refresh insights" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Refresh insights" }));
  expect(onRefresh).toHaveBeenCalledOnce();
  expect(screen.getByText("Refresh overdue")).toBeVisible();
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

it("keeps a video post visible when its provider thumbnail expires", () => {
  render(
    <InsightsDashboard
      accounts={accounts}
      content={[
        {
          ...content[0],
          contentType: "video",
          thumbnailUrl: "https://scontent.cdninstagram.com/expired.jpg",
          remotePostUrl: "https://www.instagram.com/reel/example/",
        },
      ]}
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

  fireEvent.error(screen.getByAltText("video post thumbnail"));
  fireEvent.click(screen.getByRole("button", { name: /View insights for Instagram video/ }));
  expect(screen.getByRole("heading", { name: "Video insights" })).toBeVisible();
  expect(screen.getByRole("link", { name: "Open on Instagram" })).toHaveAttribute(
    "href",
    "https://www.instagram.com/reel/example/",
  );
});

it("filters rankings and opens insights and actions beyond the first page", async () => {
  const user = userEvent.setup();
  const onSaveResearch = vi.fn();
  const connectionId = "11111111-1111-4111-8111-111111111111";
  const uploads = Array.from({ length: 14 }, (_, index) => ({
    ...content[0],
    connectionId,
    remotePostId: `reel-${index}`,
    contentType: "video" as const,
    caption: `Reel ${index}`,
    publishedAt: new Date(Date.now() - (index === 13 ? 45 : 1) * 86_400_000).toISOString(),
    views: 1_000 - index,
    detailMetrics: { skipRate: 34.75, reposts: 0 },
  }));
  render(
    <InsightsDashboard
      accounts={[
        {
          ...accounts[0],
          connectionId,
          periodMetrics: { 30: { follows: 30, unfollows: 5 }, 90: { follows: 100, unfollows: 20 } },
        },
      ]}
      content={uploads}
      history={[]}
      selectedId={connectionId}
      onSelect={() => {}}
      displayPeriodDays={30}
      savingDisplayPeriod={false}
      onDisplayPeriodChange={() => {}}
      onSaveResearch={onSaveResearch}
    />,
  );
  expect(screen.getByText("+25")).toBeVisible();
  expect(screen.getByText(/13 posts published in this period/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(screen.getByRole("button", { name: "View insights for Reel 12" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("34.75%")).toBeVisible();
  expect(within(dialog).getByText("Skip rate (first 3 seconds)")).toBeVisible();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  const reel = screen.getByRole("button", { name: "View insights for Reel 12" }).closest("article");
  expect(reel).toBeInTheDocument();
  await user.click(within(reel!).getByRole("button", { name: "Post actions" }));
  const brief = screen.getByRole("menuitem", { name: "Create content brief" });
  expect(brief).toHaveAttribute("href", "/content");
  expect(JSON.parse(brief.getAttribute("data-search") || "{}")).toEqual({
    tab: "agent",
    chat: "new",
    analyticsPost: { connectionId, remotePostId: "reel-12", intent: "brief" },
  });
  await user.keyboard("{Escape}");
  await user.click(within(reel!).getByRole("button", { name: "Post actions" }));
  await user.click(screen.getByRole("menuitem", { name: "Save to research" }));
  expect(onSaveResearch).toHaveBeenCalledWith({ connectionId, remotePostId: "reel-12" });
  fireEvent.change(screen.getByLabelText("Insights reporting period"), { target: { value: "90" } });
  expect(screen.getByText("+80")).toBeVisible();
  expect(screen.getByText(/14 posts published in this period/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByRole("button", { name: "View insights for Reel 13" })).toBeVisible();
});
