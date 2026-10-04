import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ContentDiscoverData } from "@/lib/content-discovery.functions";
import { ContentDiscover } from "./ContentDiscover";

const trend = {
  id: "11111111-1111-4111-8111-111111111111",
  fingerprint: "trend:one",
  kind: "trend" as const,
  title: "New creator AI tools launch",
  summary: "A new workflow is available.",
  sourceUrl: "https://publisher.com/news",
  sourceName: "Publisher",
  sourcePublishedAt: "2026-09-18T07:00:00.000Z",
  sourceRetrievedAt: "2026-09-18T08:00:00.000Z",
  reason: "Current news relevant to creator AI.",
  angles: [],
  metricName: null,
  metricValue: null,
  outlierScore: null,
  feedback: "pending" as const,
  platform: "YouTube",
  author: "Creator Lab",
  thumbnailUrl: null,
  stats: { views: 125_000, likes: 8_400, comments: 320 },
};

const idea = {
  ...trend,
  id: "22222222-2222-4222-8222-222222222222",
  fingerprint: "idea:one",
  kind: "idea" as const,
  title: "Your angle on creator AI",
  angles: ["What this means for creators", "My take", "A practical lesson"],
};

const data: ContentDiscoverData = {
  winners: [
    {
      connectionId: "connection",
      provider: "linkedin",
      remotePostId: "post",
      remotePostUrl: "https://linkedin.com/posts/example",
      contentType: "text",
      caption: "My best post",
      thumbnailUrl: null,
      publishedAt: "2026-09-17T08:00:00.000Z",
      views: null,
      impressions: 1_000,
      reach: null,
      engagements: 80,
      likes: 60,
      comments: 20,
      shares: null,
      saves: null,
      fetchedAt: "2026-09-18T08:00:00.000Z",
      metric: "impressions",
      value: 1_000,
      outlierScore: 2.4,
    },
  ],
  patterns: [
    {
      provider: "linkedin",
      contentType: "text",
      metric: "impressions",
      posts: 4,
      averageValue: 700,
    },
  ],
  trends: [trend],
  ideas: [idea],
  warnings: ["One source was unavailable."],
  status: "stale",
  lastRefreshedAt: "2026-09-18T08:00:00.000Z",
};

describe("ContentDiscover", () => {
  it("shows source provenance and routes feedback without fake engagement", () => {
    const onReject = vi.fn();
    render(
      <ContentDiscover
        data={data}
        now={new Date("2026-09-18T09:00:00.000Z")}
        onLike={vi.fn()}
        onSave={vi.fn()}
        onReject={onReject}
        onAskAgent={vi.fn()}
        onCreateDraft={vi.fn()}
      />,
    );
    const trends = screen.getByRole("article", { name: trend.title });
    expect(within(trends).getByRole("link", { name: "Open original source" })).toHaveAttribute(
      "href",
      trend.sourceUrl,
    );
    expect(within(trends).getByText("2h")).toBeVisible();
    fireEvent.click(
      within(trends).getByRole("button", { name: `View details for ${trend.title}` }),
    );
    expect(screen.getByRole("dialog", { name: trend.title })).toHaveClass(
      "w-[calc(100vw-1.5rem)]",
      "max-h-[90dvh]",
    );
    expect(screen.getByRole("dialog", { name: trend.title })).toHaveTextContent("125K");
    expect(screen.getByRole("link", { name: "Open original post" })).toHaveAttribute(
      "href",
      trend.sourceUrl,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(within(trends).getByRole("button", { name: `Not relevant: ${trend.title}` }));
    expect(onReject).toHaveBeenCalledWith(trend.id);
  });

  it("excludes the creator's own posts and sends a selected niche idea to Agent", () => {
    const onAskAgent = vi.fn();
    render(
      <ContentDiscover
        data={data}
        now={new Date("2026-09-18T09:00:00.000Z")}
        onLike={vi.fn()}
        onSave={vi.fn()}
        onReject={vi.fn()}
        onAskAgent={onAskAgent}
        onCreateDraft={vi.fn()}
      />,
    );
    expect(screen.queryByText("My best post")).not.toBeInTheDocument();
    const ideas = screen.getByRole("article", { name: idea.title });
    fireEvent.click(within(ideas).getByRole("button", { name: "Ask Agent" }));
    expect(onAskAgent).toHaveBeenCalledWith(idea);
    expect(screen.getByText(/One source was unavailable\./)).toBeVisible();
  });

  it("keeps cached posts visible while refreshing and exposes retry on failure", () => {
    const onRefresh = vi.fn();
    const { rerender } = render(
      <ContentDiscover
        data={data}
        refreshing
        refreshError={null}
        onRefresh={onRefresh}
        onLike={vi.fn()}
        onSave={vi.fn()}
        onReject={vi.fn()}
        onAskAgent={vi.fn()}
        onCreateDraft={vi.fn()}
      />,
    );

    expect(screen.getByRole("article", { name: trend.title })).toBeVisible();
    expect(screen.getByText("Refreshing recommendations…")).toBeVisible();

    rerender(
      <ContentDiscover
        data={data}
        refreshing={false}
        refreshError="Recommendations could not be refreshed."
        onRefresh={onRefresh}
        onLike={vi.fn()}
        onSave={vi.fn()}
        onReject={vi.fn()}
        onAskAgent={vi.fn()}
        onCreateDraft={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("article", { name: trend.title })).toBeVisible();
  });
});
