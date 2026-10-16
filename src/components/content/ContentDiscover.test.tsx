import userEvent from "@testing-library/user-event";
import { act, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
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
  sourceUrl: "https://publisher.com/another-post",
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
  it("uses backend relevance scores without treating high scores as a tracking flag", () => {
    const unfollowed = {
      ...trend,
      id: "unfollowed",
      title: "A previously tracked post",
      sourceUrl: "https://www.facebook.com/founder/posts/123",
      relevanceScore: 100,
      authorUrl: "https://www.facebook.com/founder",
    };
    render(
      <ContentDiscover
        data={{
          ...data,
          creators: [],
          trends: [unfollowed, { ...trend, relevanceScore: 10 }],
          ideas: [],
        }}
        onLike={vi.fn()}
        onSave={vi.fn()}
        onReject={vi.fn()}
        onAskAgent={vi.fn()}
        onCreateDraft={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("article")[0]).toHaveAttribute("aria-label", unfollowed.title);
    expect(screen.getAllByRole("article")[1]).toHaveAttribute("aria-label", trend.title);
  });
  it("unsaves from Saved, keeps failures visible, and allows saving the post again", async () => {
    const user = userEvent.setup();
    const onUnsave = vi
      .fn()
      .mockRejectedValueOnce(new Error("Could not unsave"))
      .mockResolvedValue(undefined);
    const onSave = vi.fn();
    render(
      <ContentDiscover
        data={{ ...data, trends: [{ ...trend, saved: true }], ideas: [] }}
        onLike={vi.fn()}
        onSave={onSave}
        onUnsave={onUnsave}
        onReject={vi.fn()}
        onAskAgent={vi.fn()}
        onCreateDraft={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Saved" }));
    await user.click(screen.getByRole("button", { name: "Unsave" }));
    expect(await screen.findByText("Could not unsave")).toBeVisible();
    expect(screen.getByRole("article", { name: trend.title })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Unsave" }));
    await waitFor(() => expect(screen.queryByRole("article")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Discover" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(screen.getByRole("menuitem", { name: /Save to Brain/ }));
    expect(onSave).toHaveBeenCalledWith(trend.id);
    expect(await screen.findByRole("button", { name: "Unsave" })).toBeVisible();
  });

  it("adds a Reddit favorite and opens its matching posts and ideas with the same cards", async () => {
    const user = userEvent.setup();
    const onTrackCreator = vi.fn().mockResolvedValue(undefined);
    const onUntrackCreator = vi.fn().mockResolvedValue(undefined);
    const reddit = {
      ...trend,
      platform: "Reddit",
      sourceUrl: "https://www.reddit.com/r/startups/comments/abc/story",
      authorUrl: "https://www.reddit.com/user/alice",
    };
    const props = {
      onLike: vi.fn(),
      onSave: vi.fn(),
      onReject: vi.fn(),
      onAskAgent: vi.fn(),
      onCreateDraft: vi.fn(),
      onTrackCreator,
      onUntrackCreator,
    };
    const feed = {
      ...data,
      trends: [reddit],
      ideas: [
        { ...reddit, id: idea.id, kind: "idea" as const, title: idea.title, angles: idea.angles },
      ],
    };
    const { rerender } = render(<ContentDiscover {...props} data={feed} />);
    await user.click(screen.getByRole("button", { name: "Creators" }));
    await user.click(screen.getByRole("button", { name: "Add creator" }));
    await user.type(
      screen.getByLabelText("Profile or community URL"),
      "https://reddit.com/r/startups/",
    );
    await user.type(screen.getByLabelText(/What interests you/), "Founder stories");
    await user.click(screen.getByRole("button", { name: "Track creator" }));
    expect(onTrackCreator).toHaveBeenCalledWith({
      profileUrl: "https://www.reddit.com/r/startups",
      name: "startups",
      topics: "Founder stories",
    });
    const creators = [
      {
        id: "tracked",
        profileUrl: "https://www.reddit.com/r/startups",
        name: "startups",
        platform: "Reddit",
        topics: "Founder stories",
        avatarUrl: null,
        lastCheckedAt: "2026-10-07",
      },
    ];
    rerender(<ContentDiscover {...props} data={{ ...feed, creators }} />);
    await user.click(screen.getByRole("button", { name: "View posts" }));
    await user.click(screen.getByRole("button", { name: "Posts" }));
    expect(screen.getByRole("article", { name: trend.title })).toBeVisible();
    expect(screen.queryByRole("article", { name: idea.title })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ideas" }));
    expect(screen.getByRole("article", { name: idea.title })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Back to Creators" }));
    await user.click(screen.getByRole("button", { name: "Untrack startups" }));
    expect(onUntrackCreator).toHaveBeenCalledWith("tracked");
  });
  it("shows source provenance and routes feedback without fake engagement", async () => {
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
    expect(within(trends).getByText("YouTube · 2h")).toBeVisible();
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
    fireEvent.click(within(trends).getByRole("button", { name: "Less like this" }));
    expect(onReject).toHaveBeenCalledWith(trend.id);
    await waitFor(() =>
      expect(screen.queryByRole("article", { name: trend.title })).not.toBeInTheDocument(),
    );
  });

  it("excludes the creator's own posts and sends a selected niche idea to Agent", async () => {
    const user = userEvent.setup();
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
    await user.click(screen.getByRole("button", { name: "Ideas" }));
    const ideas = screen.getByRole("article", { name: idea.title });
    await user.click(within(ideas).getByRole("button", { name: "Explore angles" }));
    expect(onAskAgent).toHaveBeenCalledWith(expect.objectContaining(idea), "variations");
    fireEvent.click(screen.getByText(/Feed source status/));
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

function setup(overrides: Partial<React.ComponentProps<typeof ContentDiscover>> = {}) {
  const callbacks = {
    onLike: vi.fn(),
    onSave: vi.fn(),
    onReject: vi.fn(),
    onAskAgent: vi.fn(),
    onCreateDraft: vi.fn(),
  };
  render(
    <ContentDiscover
      data={data}
      now={new Date("2026-09-18T09:00:00.000Z")}
      {...callbacks}
      {...overrides}
    />,
  );
  return { user: userEvent.setup(), ...callbacks };
}

describe("Discover interactions", () => {
  it("opens the Boost menu without opening a post and routes each intent", async () => {
    const { user, onAskAgent, onCreateDraft } = setup();
    const card = within(screen.getByRole("article", { name: trend.title }));
    for (const [label, action] of [
      ["Variations", "variations"],
      ["Reverse Engineer", "reverse-engineer"],
    ]) {
      await user.click(card.getByRole("button", { name: "Boost in chat" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      await user.click(screen.getByRole("menuitem", { name: new RegExp(label) }));
      expect(onAskAgent).toHaveBeenLastCalledWith(expect.objectContaining(trend), action);
    }
    await user.click(card.getByRole("button", { name: "Boost in chat" }));
    await user.click(screen.getByRole("menuitem", { name: /Replicate/ }));
    expect(onCreateDraft).toHaveBeenCalledWith(expect.objectContaining(trend));
  });

  it("saves from the picker and shows the result in Saved", async () => {
    const { user, onSave } = setup();
    const card = within(screen.getByRole("article", { name: trend.title }));
    await user.click(card.getByRole("button", { name: "Save" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: /Save to Brain/ }));
    expect(onSave).toHaveBeenCalledWith(trend.id);
    expect(await card.findByRole("button", { name: "Saved" })).toBeVisible();
    await user.click(
      within(screen.getByRole("navigation", { name: "Discover views" })).getByRole("button", {
        name: "Saved",
      }),
    );
    expect(screen.getByRole("article", { name: trend.title })).toBeVisible();
    expect(screen.queryByRole("article", { name: idea.title })).not.toBeInTheDocument();
  });

  it("does not hide or mark a post saved when the server rejects an action", async () => {
    const { user } = setup({
      onSave: vi.fn().mockRejectedValue(new Error("Save failed")),
      onReject: vi.fn().mockRejectedValue(new Error("Hide failed")),
    });
    const card = within(screen.getByRole("article", { name: trend.title }));
    await user.click(card.getByRole("button", { name: "Save" }));
    await user.click(screen.getByRole("menuitem", { name: /Save to Brain/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
    expect(card.getByRole("button", { name: "Save" })).toBeVisible();
    await user.click(card.getByRole("button", { name: "Less like this" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Hide failed");
    expect(screen.getByRole("article", { name: trend.title })).toBeVisible();
  });

  it("filters search, media and platform, then resets to the full feed", async () => {
    const photo = {
      ...idea,
      kind: "trend" as const,
      platform: "Instagram",
      thumbnailUrl: "https://example.com/photo.jpg",
    };
    const { user } = setup({ data: { ...data, trends: [trend, photo], ideas: [] } });
    await user.type(screen.getByRole("searchbox", { name: "Search Discover" }), "Your angle");
    expect(screen.queryByRole("article", { name: trend.title })).not.toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox", { name: "Search Discover" }));
    await user.click(screen.getByRole("button", { name: "Media only" }));
    expect(screen.queryByRole("article", { name: trend.title })).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: idea.title })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open feed filters" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Discover platform" }),
      "YouTube",
    );
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.getByText("No posts match these filters yet")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Reset filters" }));
    await user.keyboard("{Escape}");
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("opens a creator's feed separately from the post overlay", async () => {
    const other = { ...idea, kind: "trend" as const, author: "Another creator" };
    const { user } = setup({ data: { ...data, trends: [trend, other], ideas: [] } });
    await user.click(
      within(screen.getByRole("article", { name: trend.title })).getByRole("button", {
        name: "View creator Creator Lab",
      }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Creator Lab" })).toBeVisible();
    expect(screen.queryByRole("article", { name: idea.title })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to Discover" }));
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("opens details with the keyboard, copies text and navigates related posts", async () => {
    const { user } = setup({
      data: { ...data, trends: [trend, { ...idea, kind: "trend" }], ideas: [] },
    });
    const open = screen.getByRole("button", { name: `View details for ${trend.title}` });
    open.focus();
    await user.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog", { name: trend.title });
    await user.click(within(dialog).getByRole("button", { name: "Copy text" }));
    expect(await navigator.clipboard.readText()).toBe(`${trend.title}\n\n${trend.summary}`);
    expect(within(dialog).getByText("Copied")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: new RegExp(idea.title) }));
    expect(screen.getByRole("dialog", { name: idea.title })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(open).toHaveFocus();
  });

  it("lets users undo More like this", async () => {
    const onClearFeedback = vi.fn();
    const { user, onLike } = setup({ onClearFeedback });
    const button = within(screen.getByRole("article", { name: trend.title })).getByRole("button", {
      name: "More like this",
    });
    await user.click(button);
    expect(onLike).toHaveBeenCalledWith(trend.id);
    expect(button).toHaveAttribute("aria-pressed", "true");
    await user.click(button);
    expect(onClearFeedback).toHaveBeenCalledWith(trend.id);
    expect(button).toHaveAttribute("aria-pressed", "false");
  });

  it("shows failed post actions inside the open dialog", async () => {
    const { user } = setup({
      onReject: vi.fn().mockRejectedValue(new Error("Could not hide post")),
    });
    await user.click(screen.getByRole("button", { name: `View details for ${trend.title}` }));
    const dialog = within(screen.getByRole("dialog", { name: trend.title }));
    await user.click(dialog.getByRole("button", { name: "Hide" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("Could not hide post");
    expect(screen.getByRole("dialog", { name: trend.title })).toBeVisible();
  });
});

it("shows fetched creator photos and opens the original reel with its real source link", async () => {
  const reel = {
    ...trend,
    platform: "Instagram",
    sourceUrl: "https://www.instagram.com/reel/Abcdef123/",
    authorUrl: "https://www.instagram.com/creator/",
    authorAvatarUrl: "https://scontent.cdninstagram.com/avatar.jpg",
    thumbnailUrl: "https://scontent.cdninstagram.com/reel.jpg",
    mediaType: "video" as const,
  };
  const { user } = setup({ data: { ...data, trends: [reel], ideas: [] } });
  const article = screen.getByRole("article", { name: trend.title });
  expect(
    article.querySelector('img[src="https://scontent.cdninstagram.com/avatar.jpg"]'),
  ).toBeInTheDocument();
  expect(
    article.querySelector('img[src="https://scontent.cdninstagram.com/reel.jpg"]'),
  ).toBeInTheDocument();
  expect(within(article).getByRole("link", { name: "Open original source" })).toHaveAttribute(
    "href",
    reel.sourceUrl,
  );
  expect(within(article).getByText("Reel")).toBeVisible();
  await user.click(within(article).getByRole("button", { name: `View details for ${reel.title}` }));
  const dialog = screen.getByRole("dialog", { name: reel.title });
  expect(within(dialog).getByTitle(`Original post: ${reel.title}`)).toHaveAttribute(
    "src",
    "https://www.instagram.com/reel/Abcdef123/embed/",
  );
  expect(within(dialog).getByRole("link", { name: /Open creator profile/ })).toHaveAttribute(
    "href",
    reel.authorUrl,
  );
});

it("plays supplied videos and navigates every image in a carousel", async () => {
  const carousel = {
    ...trend,
    mediaType: "carousel" as const,
    media: [
      { type: "image" as const, url: "https://example.com/1.jpg" },
      { type: "image" as const, url: "https://example.com/2.jpg" },
      { type: "video" as const, url: "https://example.com/video.mp4" },
    ],
  };
  const { user } = setup({ data: { ...data, trends: [carousel], ideas: [] } });
  await user.click(screen.getByRole("button", { name: `View details for ${trend.title}` }));
  const dialog = screen.getByRole("dialog", { name: trend.title });
  expect(dialog.querySelector('img[src="https://example.com/1.jpg"]')).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Next media" }));
  expect(dialog.querySelector('img[src="https://example.com/2.jpg"]')).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Next media" }));
  expect(dialog.querySelector("video")).toHaveAttribute("src", "https://example.com/video.mp4");
  expect(within(dialog).getByRole("button", { name: "Next media" })).toBeDisabled();
});

it("shows related thumbnails across platforms, loads more, and excludes duplicate source ideas", async () => {
  const posts = Array.from({ length: 16 }, (_, index) => ({
    ...trend,
    id: `related-${index}`,
    title: `Creator workflow ${index}`,
    sourceUrl: `https://publisher.com/posts/${index}`,
    platform: index % 2 ? "Instagram" : "YouTube",
    author: `Creator ${index}`,
    thumbnailUrl: `https://example.com/cover-${index}.jpg`,
  }));
  const duplicate = { ...posts[0], id: "duplicate-idea", kind: "idea" as const };
  const { user } = setup({
    data: {
      ...data,
      trends: [trend, ...posts],
      ideas: [{ ...idea, sourceUrl: trend.sourceUrl }, duplicate],
    },
  });
  await user.click(screen.getByRole("button", { name: `View details for ${trend.title}` }));
  const related = within(screen.getByRole("region", { name: "Related posts" }));
  expect(related.getAllByRole("button", { name: /View related post:/ })).toHaveLength(12);
  expect(
    screen.getByRole("region", { name: "Related posts" }).querySelectorAll("img"),
  ).toHaveLength(12);
  await user.click(related.getByRole("button", { name: "Show more posts" }));
  expect(related.getAllByRole("button", { name: /View related post:/ })).toHaveLength(16);
  expect(related.queryByRole("button", { name: "Show more posts" })).not.toBeInTheDocument();
  await user.click(related.getByRole("button", { name: "View related post: Creator workflow 15" }));
  expect(screen.getByRole("dialog", { name: "Creator workflow 15" })).toBeVisible();
});

it("keeps a saved post in Saved after liking and clearing a preference", async () => {
  const { user } = setup({ onClearFeedback: vi.fn() });
  const card = within(screen.getByRole("article", { name: trend.title }));
  await user.click(card.getByRole("button", { name: "Save" }));
  await user.click(screen.getByRole("menuitem", { name: /Save to Brain/ }));
  await user.click(card.getByRole("button", { name: "More like this" }));
  expect(card.getByRole("button", { name: "Saved" })).toBeVisible();
  await user.click(card.getByRole("button", { name: "More like this" }));
  await user.click(
    within(screen.getByRole("navigation", { name: "Discover views" })).getByRole("button", {
      name: "Saved",
    }),
  );
  expect(screen.getByRole("article", { name: trend.title })).toBeVisible();
});

it("separates real posts from actionable ideas and requires recent performance evidence", async () => {
  const { user, onCreateDraft } = setup();
  expect(screen.queryByRole("article", { name: idea.title })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Posts" }));
  expect(screen.getByRole("article", { name: trend.title })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Ideas" }));
  expect(screen.queryByRole("article", { name: trend.title })).not.toBeInTheDocument();
  const brief = within(screen.getByRole("article", { name: idea.title }));
  expect(brief.getByText("What this means for creators")).toBeVisible();
  expect(brief.queryByText(trend.summary)).not.toBeInTheDocument();
  expect(brief.queryByText("125K")).not.toBeInTheDocument();
  expect(brief.getByRole("link", { name: "View inspiration" })).toHaveAttribute(
    "href",
    idea.sourceUrl,
  );
  await user.click(brief.getByRole("button", { name: "Create draft" }));
  expect(onCreateDraft).toHaveBeenCalledWith(expect.objectContaining(idea));
  await user.click(screen.getByRole("button", { name: "For you" }));
  await user.click(screen.getByRole("button", { name: "Gaining traction" }));
  expect(screen.getAllByRole("article")).toHaveLength(1);
});

it("refreshes, dismisses the tip, and opens creator posts from the directory", async () => {
  const onRefresh = vi.fn();
  const { user } = setup({ onRefresh });
  await user.click(screen.getByRole("button", { name: "Refresh feed" }));
  expect(onRefresh).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByText("Save 3 posts you wish you’d made")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Creators" }));
  await user.click(screen.getByRole("button", { name: /View posts/ }));
  expect(screen.getByRole("heading", { name: "Creator Lab" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Back to Creators" }));
  expect(screen.getByRole("heading", { name: "Creators" })).toBeVisible();
});

it("shows one copy of a source across posts, ideas and tracking URL variants", async () => {
  const { user } = setup({
    data: {
      ...data,
      trends: [trend, { ...trend, id: "copy", sourceUrl: `${trend.sourceUrl}/?utm_source=share` }],
      ideas: [{ ...idea, sourceUrl: trend.sourceUrl }],
    },
  });
  expect(screen.getAllByRole("article")).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Ideas" }));
  expect(screen.getAllByRole("article")).toHaveLength(1);
  expect(screen.getByRole("article", { name: idea.title })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "For you" }));
  expect(screen.getAllByRole("article")).toHaveLength(1);
});

it("does not substitute undated posts when recent performance cannot be verified", async () => {
  const { user } = setup({
    data: {
      ...data,
      trends: [{ ...trend, stats: {}, sourcePublishedAt: null, saved: true }],
      ideas: [],
    },
  });
  expect(screen.queryByRole("article")).not.toBeInTheDocument();
  expect(
    within(screen.getByRole("combobox", { name: "Feed date range" })).queryByRole("option", {
      name: /All dates/,
    }),
  ).not.toBeInTheDocument();
  await user.click(
    within(screen.getByRole("navigation", { name: "Discover views" })).getByRole("button", {
      name: /^Saved$/,
    }),
  );
  expect(screen.getByText("YouTube · Date unavailable")).toBeVisible();
  expect(screen.getByText("Metrics unavailable")).toBeVisible();
  await user.click(
    within(screen.getByRole("navigation", { name: "Discover views" })).getByRole("button", {
      name: /^Discover$/,
    }),
  );
  await user.click(screen.getByRole("button", { name: "Gaining traction" }));
  expect(screen.queryByRole("article")).not.toBeInTheDocument();
  expect(screen.getByText(/No posts in this selection have a verified date/)).toBeVisible();
  expect(screen.queryByText("0 views")).not.toBeInTheDocument();
});

it("hides a source's generated idea too after rejecting its original post", async () => {
  const { user } = setup({ data: { ...data, ideas: [{ ...idea, sourceUrl: trend.sourceUrl }] } });
  await user.click(
    within(screen.getByRole("article", { name: trend.title })).getByRole("button", {
      name: "Less like this",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("article")).not.toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: "Ideas" }));
  expect(screen.queryByRole("article")).not.toBeInTheDocument();
});

it("shows matched established creators without pretending their posts are already loaded", async () => {
  const onTrackCreator = vi.fn().mockResolvedValue(undefined);
  const { user } = setup({
    onTrackCreator,
    data: {
      ...data,
      trends: [],
      ideas: [],
      suggestedCreators: [
        {
          id: "reference:alex",
          name: "Alex Hormozi",
          profileUrl: "https://www.youtube.com/@AlexHormozi",
          platform: "YouTube",
          topics: ["startup journey"],
          description: "Business building and practical offers.",
          reason: "Matches your Brain: startup journey.",
          source: "brain",
          score: 40,
        },
      ],
    },
  });
  await user.click(screen.getByRole("button", { name: "Creators" }));
  expect(screen.getByText("Alex Hormozi")).toBeVisible();
  expect(screen.getByText("Matches your Brain: startup journey.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "View posts" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Track Alex Hormozi" }));
  expect(onTrackCreator).toHaveBeenCalledWith({
    profileUrl: "https://www.youtube.com/@AlexHormozi",
    name: "Alex Hormozi",
    topics: "startup journey",
  });
  await user.type(screen.getByRole("searchbox"), "unrelated");
  expect(screen.queryByText("Alex Hormozi")).not.toBeInTheDocument();
});

it("keeps date and platform filters strict instead of filling with older or unrelated posts", async () => {
  const old = {
    ...trend,
    id: "old",
    title: "A popular post from years ago",
    sourceUrl: "https://example.com/archive",
    sourcePublishedAt: "2023-09-18T07:00:00Z",
    saved: true,
    savedOnly: true,
    stats: { views: 9_000_000 },
  };
  const recent = {
    ...trend,
    id: "recent",
    title: "A recent Instagram post",
    platform: "Instagram",
    sourceUrl: "https://instagram.com/p/recent",
  };
  const onRefresh = vi.fn();
  const { user } = setup({
    data: { ...data, trends: [old, recent], ideas: [] },
    onRefresh,
    availablePlatforms: ["YouTube", "Instagram"],
  });
  expect(screen.queryByRole("article", { name: old.title })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "YouTube" }));
  expect(screen.queryByRole("article")).not.toBeInTheDocument();
  expect(screen.getByText(/verified publish date in the last 30 days/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Find fresh posts" }));
  expect(onRefresh).toHaveBeenCalledTimes(1);
  await user.click(
    within(screen.getByRole("navigation", { name: "Discover views" })).getByRole("button", {
      name: /^Saved$/,
    }),
  );
  expect(screen.getByRole("article", { name: old.title })).toBeVisible();
  expect(screen.queryByRole("article", { name: recent.title })).not.toBeInTheDocument();
  expect(screen.getByText(/YouTube · Archive · 3y/)).toBeVisible();
});

it("shows generated hooks and outlines as a creation brief rather than the source post", async () => {
  const creation = {
    ...idea,
    summary: "Explain your own three-step test.",
    inspiration: {
      hook: "I tested this workflow for a week. Here is what changed.",
      format: "Short video",
      outline: ["Show the starting point", "Compare the result", "Share what you would change"],
      whyNow: "Build on this week’s discussion.",
    },
  };
  const { user } = setup({ data: { ...data, ideas: [creation] } });
  await user.click(screen.getByRole("button", { name: "Ideas" }));
  const article = within(screen.getByRole("article", { name: idea.title }));
  expect(article.getByText(creation.inspiration.hook)).toBeVisible();
  expect(article.getByText("Show the starting point")).toBeVisible();
  expect(article.getByText("Short video")).toBeVisible();
  expect(article.getByText("Inspired by a real post")).toBeVisible();
  expect(article.queryByRole("img")).not.toBeInTheDocument();
  expect(article.queryByText(trend.summary)).not.toBeInTheDocument();
});

it("renders a progress skeleton during initial research and announces automatic retries", () => {
  setup({
    data: { ...data, trends: [], ideas: [] },
    refreshing: true,
    refreshStatus: "Connection interrupted. Retrying automatically…",
  });
  expect(screen.getByText("Connection interrupted. Retrying automatically…")).toBeVisible();
  expect(screen.queryByText("No posts match these filters yet")).not.toBeInTheDocument();
  expect(document.querySelectorAll(".discover-skeleton-card")).toHaveLength(6);
  expect(document.querySelector(".discover-loading")).toHaveAttribute("aria-busy", "true");
});

it("keeps the complete source collection in For You as well as Posts", async () => {
  const many = Array.from({ length: 8 }, (_, index) => ({
    ...trend,
    id: `post-${index}`,
    title: `Original source ${index}`,
    sourceUrl: `https://example.com/posts/${index}`,
  }));
  const another = {
    ...trend,
    id: "instagram",
    title: "Another perspective",
    platform: "Instagram",
    author: "Another creator",
    sourceUrl: "https://instagram.com/p/unique",
  };
  const { user } = setup({ data: { ...data, trends: [...many, another], ideas: [] } });
  expect(screen.getAllByRole("article")).toHaveLength(9);
  expect(screen.getByRole("article", { name: another.title })).toBeVisible();
  await user.click(screen.getByRole("button", { name: /^Posts$/ }));
  expect(screen.getByRole("button", { name: /^Posts$/ })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getAllByRole("article")).toHaveLength(9);
});

it("keeps saved posts from a previous Brain direction out of Discover but available in Saved", async () => {
  const unrelatedSaved = {
    ...trend,
    id: "previous-brain-save",
    title: "Saved from a previous interest",
    sourceUrl: "https://example.com/previous-interest",
    platform: "Instagram",
    author: "Previous-interest creator",
    saved: true,
    savedOnly: true,
  };
  const { user } = setup({ data: { ...data, trends: [trend, unrelatedSaved], ideas: [] } });
  expect(screen.getByRole("article", { name: trend.title })).toBeVisible();
  expect(screen.queryByRole("article", { name: unrelatedSaved.title })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Instagram$/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: `View details for ${trend.title}` }));
  expect(
    screen.queryByRole("button", { name: `View related post: ${unrelatedSaved.title}` }),
  ).not.toBeInTheDocument();
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: /^Posts$/ }));
  expect(screen.queryByRole("article", { name: unrelatedSaved.title })).not.toBeInTheDocument();
  await user.click(
    within(screen.getByRole("navigation", { name: "Discover views" })).getByRole("button", {
      name: /^Saved$/,
    }),
  );
  expect(screen.getByRole("article", { name: unrelatedSaved.title })).toBeVisible();
  expect(screen.queryByRole("article", { name: trend.title })).not.toBeInTheDocument();
});

it("resets creator, search and feed filters when the Brain direction or locale changes", async () => {
  const user = userEvent.setup();
  const callbacks = {
    onLike: vi.fn(),
    onSave: vi.fn(),
    onReject: vi.fn(),
    onAskAgent: vi.fn(),
    onCreateDraft: vi.fn(),
  };
  const initial = { ...data, directionKey: "startup:en:global" };
  const { rerender } = render(
    <ContentDiscover {...callbacks} data={initial} now={new Date("2026-09-18T09:00:00Z")} />,
  );
  await user.click(
    within(screen.getByRole("article", { name: trend.title })).getByRole("button", {
      name: "View creator Creator Lab",
    }),
  );
  await user.click(screen.getByRole("button", { name: /^YouTube$/ }));
  await user.type(screen.getByRole("searchbox", { name: "Search Discover" }), "creator AI");
  await user.click(screen.getByRole("button", { name: "Media only" }));
  await user.click(screen.getByRole("button", { name: "Gaining traction" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Feed date range" }), "7");
  const lifestyle = {
    ...trend,
    id: "new-interest",
    title: "A recent lifestyle story",
    author: "Lifestyle creator",
    platform: "Instagram",
    sourceUrl: "https://instagram.com/p/lifestyle",
    stats: {},
  };
  rerender(
    <ContentDiscover
      {...callbacks}
      data={{ ...data, directionKey: "lifestyle:hi:india", trends: [lifestyle], ideas: [] }}
      now={new Date("2026-09-18T09:00:00Z")}
    />,
  );
  expect(screen.getByRole("heading", { name: /^Discover$/ })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Creator Lab" })).not.toBeInTheDocument();
  expect(screen.getByRole("searchbox", { name: "Search Discover" })).toHaveValue("");
  expect(screen.getByRole("combobox", { name: "Feed date range" })).toHaveValue("30");
  expect(screen.getByRole("button", { name: "Media only" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(screen.getByRole("button", { name: "Gaining traction" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(screen.getByRole("article", { name: lifestyle.title })).toBeVisible();
});

it("preserves Saved when the direction changes while clearing stale saved filters", async () => {
  const user = userEvent.setup();
  const callbacks = {
    onLike: vi.fn(),
    onSave: vi.fn(),
    onReject: vi.fn(),
    onAskAgent: vi.fn(),
    onCreateDraft: vi.fn(),
  };
  const saved = {
    ...trend,
    saved: true,
    savedOnly: true,
    sourcePublishedAt: "2023-01-01T00:00:00Z",
  };
  const savedData = { ...data, directionKey: "first", trends: [saved], ideas: [] };
  const { rerender } = render(<ContentDiscover {...callbacks} data={savedData} />);
  await user.click(
    within(screen.getByRole("navigation", { name: "Discover views" })).getByRole("button", {
      name: /^Saved$/,
    }),
  );
  await user.type(screen.getByRole("searchbox"), "a stale search");
  rerender(<ContentDiscover {...callbacks} data={{ ...savedData, directionKey: "second" }} />);
  expect(screen.getByRole("heading", { name: /^Saved$/ })).toBeVisible();
  expect(screen.getByRole("searchbox")).toHaveValue("");
  expect(screen.getByRole("combobox", { name: "Feed date range" })).toHaveValue("0");
  expect(screen.getByRole("article", { name: saved.title })).toBeVisible();
});

it("offers only supported source performance controls without unavailable outlier filters", async () => {
  const { user } = setup();
  await user.click(screen.getByRole("button", { name: "Open feed filters" }));
  const sort = screen.getByRole("combobox", { name: "Sort by" });
  expect(
    within(sort)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["For you", "Newest", "Most liked", "Most viewed"]);
  expect(screen.queryByRole("combobox", { name: "Min outlier score" })).not.toBeInTheDocument();
  expect(
    within(screen.getByRole("combobox", { name: "Posted within" }))
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value),
  ).toEqual(["1", "7", "30"]);
  expect(
    screen.getByText(/Social posts need 1K\+ followers and either 10K\+ views or 100\+ likes/),
  ).toBeVisible();
  await user.selectOptions(sort, "likes");
  await user.keyboard("{Escape}");
  expect(screen.getByRole("article", { name: trend.title })).toBeVisible();
  expect(screen.getByRole("button", { name: "Gaining traction" })).toBeVisible();
});

it("reveals every cached eligible post before requesting another source page", async () => {
  const many = Array.from({ length: 41 }, (_, index) => ({
    ...trend,
    id: `many-${index}`,
    title: `Eligible source ${index}`,
    sourceUrl: `https://example.com/eligible/${index}`,
  }));
  const onLoadMore = vi.fn();
  const { user } = setup({
    data: { ...data, trends: many, ideas: [] },
    onLoadMore,
    pagination: { all: { cursor: "next-page", hasMore: true, loading: false, error: null } },
  });
  expect(screen.getAllByRole("article")).toHaveLength(18);
  await user.click(screen.getByRole("button", { name: "Show more posts" }));
  expect(screen.getAllByRole("article")).toHaveLength(36);
  await user.click(screen.getByRole("button", { name: "Show more posts" }));
  expect(screen.getAllByRole("article")).toHaveLength(41);
  expect(onLoadMore).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Load more posts" }));
  expect(onLoadMore).toHaveBeenCalledWith("all", false);
}, 12_000);

it("appends new source pages without duplicates or moving the posts already being read", () => {
  const callbacks = {
    onLike: vi.fn(),
    onSave: vi.fn(),
    onReject: vi.fn(),
    onAskAgent: vi.fn(),
    onCreateDraft: vi.fn(),
    onLoadMore: vi.fn(),
  };
  const props = { ...callbacks, now: new Date("2026-09-18T09:00:00Z") };
  const feed = { ...data, trends: [trend], ideas: [] };
  const { rerender } = render(
    <ContentDiscover
      {...props}
      data={feed}
      pagination={{ all: { cursor: "page-2", hasMore: true, loading: false, error: null } }}
    />,
  );
  const original = screen.getByRole("article", { name: trend.title });
  rerender(
    <ContentDiscover
      {...props}
      data={feed}
      pagination={{
        all: {
          cursor: "page-2",
          hasMore: true,
          loading: true,
          error: null,
          status: "Checking the next page…",
        },
      }}
    />,
  );
  expect(screen.getByRole("article", { name: trend.title })).toBe(original);
  expect(document.querySelectorAll(".discover-grid > .discover-skeleton-card")).toHaveLength(3);
  expect(screen.getByText("Checking the next page…")).toBeVisible();
  const next = {
    ...trend,
    id: "new-page-post",
    title: "New page source",
    sourceUrl: "https://example.com/page-two",
    relevanceScore: 1000,
  };
  rerender(
    <ContentDiscover
      {...props}
      data={{
        ...feed,
        trends: [
          trend,
          { ...trend, id: "alias", sourceUrl: `${trend.sourceUrl}?utm_source=share` },
          next,
        ],
      }}
      pagination={{ all: { cursor: null, hasMore: false, loading: false, error: null } }}
    />,
  );
  expect(screen.getAllByRole("article")).toHaveLength(2);
  expect(screen.getAllByRole("article")[0]).toBe(original);
  expect(screen.getAllByRole("article")[1]).toHaveAttribute("aria-label", next.title);
  expect(document.querySelector(".discover-skeleton-card")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Load more posts" })).not.toBeInTheDocument();
  rerender(
    <ContentDiscover
      {...props}
      data={{ ...feed, trends: [trend, next], lastRefreshedAt: "2026-09-18T09:01:00Z" }}
    />,
  );
  expect(screen.getAllByRole("article")[0]).toHaveAttribute("aria-label", next.title);
});

it("loads an empty selected platform independently of another platform's pending page", async () => {
  const onLoadMore = vi.fn();
  const { user } = setup({
    data: { ...data, trends: [trend], ideas: [] },
    onLoadMore,
    availablePlatforms: ["YouTube", "Instagram"],
    pagination: {
      all: { cursor: "all-next", hasMore: true, loading: true, error: null },
      Instagram: { cursor: "instagram-next", hasMore: true, loading: false, error: null },
    },
  });
  await user.click(screen.getByRole("button", { name: /^Instagram$/ }));
  expect(screen.queryByRole("article")).not.toBeInTheDocument();
  expect(document.querySelector(".discover-skeleton-card")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Load more Instagram posts" }));
  expect(onLoadMore).toHaveBeenCalledWith("Instagram", false);
});

it("prefetches near the end only once per cursor and keeps manual retry after a page failure", async () => {
  const observers: Array<{
    callback: IntersectionObserverCallback;
    node?: Element;
    disconnected: boolean;
  }> = [];
  class Observer {
    record: (typeof observers)[number];
    constructor(callback: IntersectionObserverCallback) {
      this.record = { callback, disconnected: false };
      observers.push(this.record);
    }
    observe(node: Element) {
      this.record.node = node;
    }
    disconnect() {
      this.record.disconnected = true;
    }
    unobserve() {}
    takeRecords() {
      return [];
    }
  }
  vi.stubGlobal("IntersectionObserver", Observer);
  try {
    const onLoadMore = vi.fn();
    const callbacks = {
      onLike: vi.fn(),
      onSave: vi.fn(),
      onReject: vi.fn(),
      onAskAgent: vi.fn(),
      onCreateDraft: vi.fn(),
      onLoadMore,
    };
    const props = {
      ...callbacks,
      data: { ...data, trends: [trend], ideas: [] },
      now: new Date("2026-09-18T09:00:00Z"),
    };
    const { rerender } = render(
      <ContentDiscover
        {...props}
        pagination={{ all: { cursor: "page-2", hasMore: true, loading: false, error: null } }}
      />,
    );
    const observer = observers.find((entry) =>
      entry.node?.classList.contains("discover-pagination"),
    )!;
    act(() => {
      observer.callback(
        [{ isIntersecting: true, target: observer.node } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
      observer.callback(
        [{ isIntersecting: true, target: observer.node } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    rerender(
      <ContentDiscover
        {...props}
        pagination={{
          all: {
            cursor: "page-2",
            hasMore: true,
            loading: false,
            error: "This page could not be loaded.",
          },
        }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("This page could not be loaded.");
    expect(screen.getByRole("article", { name: trend.title })).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: "Try loading again" }));
    expect(onLoadMore).toHaveBeenLastCalledWith("all", true);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("shows reported audience size and filters only on observed performance", async () => {
  const known = { ...trend, stats: { views: 125000, likes: 8400, followers: 45000 } };
  const unknown = {
    ...trend,
    id: "unknown-audience",
    title: "Audience size unavailable",
    sourceUrl: "https://example.com/no-audience",
    stats: { views: 999999, likes: 9999 },
  };
  const { user } = setup({ data: { ...data, trends: [known, unknown], ideas: [] } });
  expect(
    within(screen.getByRole("article", { name: trend.title })).getByText("45K followers"),
  ).toBeVisible();
  expect(
    within(screen.getByRole("article", { name: unknown.title })).queryByText(/followers/),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Open feed filters" }));
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Minimum creator followers" }),
    "10000",
  );
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Minimum reported views" }),
    "100000",
  );
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Minimum reported likes" }),
    "1000",
  );
  await user.keyboard("{Escape}");
  expect(screen.getAllByRole("article")).toHaveLength(1);
  expect(screen.getByRole("article", { name: trend.title })).toBeVisible();
});

it("expands existing ideas without requesting provider pages that only return posts", async () => {
  const onLoadMore = vi.fn();
  const ideas = Array.from({ length: 20 }, (_, index) => ({
    ...idea,
    id: `idea-${index}`,
    title: `Original angle ${index}`,
    sourceUrl: `https://example.com/idea-source/${index}`,
  }));
  const { user } = setup({
    data: { ...data, trends: [trend], ideas },
    onLoadMore,
    pagination: { all: { cursor: "posts-page-2", hasMore: true, loading: false, error: null } },
  });
  await user.click(screen.getByRole("button", { name: /^Ideas$/ }));
  expect(screen.getAllByRole("article")).toHaveLength(18);
  await user.click(screen.getByRole("button", { name: "Show more ideas" }));
  expect(screen.getAllByRole("article")).toHaveLength(20);
  expect(screen.queryByRole("button", { name: "Load more posts" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("More Discover inspiration")).not.toBeInTheDocument();
  expect(onLoadMore).not.toHaveBeenCalled();
});
