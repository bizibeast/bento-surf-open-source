import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LiveSocialGallery, LiveSocialTile } from "./LiveSocialBlock";
import { liveSocialRefetchInterval } from "./live-social-refetch";
import { githubActivityWeekCount } from "@/lib/github-activity";
import { getSocialPreview, type SocialPreview } from "@/lib/social-preview.functions";

vi.mock("@/lib/social-preview.functions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/social-preview.functions")>();
  return { ...actual, getSocialPreview: vi.fn() };
});

const EMPTY_PREVIEW: SocialPreview = {
  followerCount: null,
  metricName: "followers",
  recentPosts: [],
  contributions: [],
  latestVideo: null,
  available: false,
};
const TEST_BLOCK_ID = "11111111-1111-4111-8111-111111111111";

function queryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function renderGitHubTile(width: number, height: number) {
  return render(
    <QueryClientProvider client={queryClient()}>
      <LiveSocialTile
        platform="github"
        showGraph
        blockId={TEST_BLOCK_ID}
        liveEnabled
        fallbackFollowerCount={2}
        w={width}
        h={height}
      />
    </QueryClientProvider>,
  );
}

function renderInstagramGallery() {
  return render(
    <QueryClientProvider client={queryClient()}>
      <LiveSocialGallery
        platform="instagram"
        handle="bento.surf"
        blockId={TEST_BLOCK_ID}
        liveEnabled
        fallbackUrls={[]}
        w={4}
        h={2}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(getSocialPreview).mockReset();
  vi.mocked(getSocialPreview).mockResolvedValue(EMPTY_PREVIEW);
});

describe("GitHub activity grid sizing", () => {
  it.each([
    [2, 4, 21],
    [3, 3, 35],
    [4, 2, 28],
    [4, 4, 48],
  ])("fits %i×%i cards using %i weeks", (width, height, expectedWeeks) => {
    expect(githubActivityWeekCount(width, height)).toBe(expectedWeeks);
  });

  it("uses the wide reference layout for a 2x4 block", () => {
    renderGitHubTile(4, 2);

    const tile = screen.getByTestId("github-activity-tile");
    expect(tile).toHaveAttribute("data-layout", "horizontal");
    expect(tile).toHaveAttribute("href", "https://github.com/");
    expect(tile.tagName).toBe("A");
    expect(tile).toHaveClass("rounded-[28px]");
    expect(screen.getByTestId("github-activity-grid")).toHaveAttribute("data-weeks", "28");
    expect(screen.getByText("Follow").closest("span")).toHaveClass("rounded-full");
  });

  it("uses the stacked reference layout for a 4x4 block", () => {
    renderGitHubTile(4, 4);

    expect(screen.getByTestId("github-activity-tile")).toHaveAttribute("data-layout", "stacked");
    expect(screen.getByTestId("github-activity-grid")).toHaveAttribute("data-weeks", "48");
  });

  it("renders a basic social tile and makes no preview request when premium data is locked", () => {
    render(
      <QueryClientProvider client={queryClient()}>
        <LiveSocialTile
          platform="github"
          handle="octocat"
          blockId={TEST_BLOCK_ID}
          showGraph
          liveEnabled={false}
          w={4}
          h={2}
        />
      </QueryClientProvider>,
    );

    expect(screen.queryByTestId("github-activity-grid")).not.toBeInTheDocument();
    expect(vi.mocked(getSocialPreview)).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: /GitHub @octocat/ })).toBeInTheDocument();
  });
});

describe("Instagram gallery resilience", () => {
  it("keeps polling unfinished Instagram previews without a fixed retry cap", () => {
    expect(liveSocialRefetchInterval("instagram", EMPTY_PREVIEW, 100)).toBe(false);
    expect(
      liveSocialRefetchInterval(
        "instagram",
        { ...EMPTY_PREVIEW, available: true, refreshing: true },
        100,
      ),
    ).toBe(30_000);
    expect(
      liveSocialRefetchInterval(
        "instagram",
        { ...EMPTY_PREVIEW, available: true, refreshing: false },
        100,
      ),
    ).toBe(false);
  });

  it("makes the whole card clickable and renders no empty media placeholders", async () => {
    renderInstagramGallery();

    const tile = screen.getByTestId("social-gallery-tile");
    expect(tile.tagName).toBe("A");
    expect(tile).toHaveAttribute("href", "https://instagram.com/bento.surf");
    await waitFor(() => expect(getSocialPreview).toHaveBeenCalled());
    expect(screen.queryByTestId("social-post-grid")).not.toBeInTheDocument();
  });

  it("removes images that fail to load instead of leaving broken boxes", async () => {
    vi.mocked(getSocialPreview).mockResolvedValue({
      ...EMPTY_PREVIEW,
      available: true,
      recentPosts: [
        { imageUrl: "https://images.example.com/one.jpg" },
        { imageUrl: "https://images.example.com/two.jpg" },
      ],
    });
    const { container } = renderInstagramGallery();

    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(2));
    fireEvent.error(container.querySelectorAll("img")[0]!);
    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(1));
    expect(screen.getByTestId("social-post-grid").children).toHaveLength(1);
  });
});

describe("public social metric resilience", () => {
  it.each(["linkedin", "reddit"])(
    "briefly retries an unavailable %s preview and stops after the retry window",
    (platform) => {
      expect(liveSocialRefetchInterval(platform, EMPTY_PREVIEW, 1)).toBe(false);
      expect(liveSocialRefetchInterval(platform, { ...EMPTY_PREVIEW, refreshing: true }, 2)).toBe(
        8_000,
      );
      expect(
        liveSocialRefetchInterval(
          platform,
          { ...EMPTY_PREVIEW, followerCount: 42, available: true },
          1,
        ),
      ).toBe(false);
    },
  );
});
