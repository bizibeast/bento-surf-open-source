import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InstagramAudioCatalog } from "./InstagramAudioCatalog";
import { getInstagramAudioCatalog } from "@/lib/instagram-audio.functions";

vi.mock("@/lib/instagram-audio.functions", () => ({ getInstagramAudioCatalog: vi.fn() }));
vi.mock("@/lib/social-oauth.functions", () => ({ beginSocialConnection: vi.fn() }));

const connectionId = "00000000-0000-4000-8000-000000000001";
const video = {
  key: "image/owner/reel.mp4",
  url: "https://cdn.bento.surf/reel.mp4",
  name: "reel.mp4",
  mimeType: "video/mp4",
  size: 10000,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getInstagramAudioCatalog).mockResolvedValue({
    connected: true,
    connectionId,
    type: "music",
    query: "",
    mode: "trending",
    observedAt: "2026-11-22T00:00:00Z",
    limitations: [],
    nextStep: null,
    tracks: [
      {
        id: "587784541076604",
        title: "Catalog song",
        creator: "Artist",
        durationMs: 45000,
        previewUrl: "https://cdninstagram.com/preview.m4a",
        artworkUrl: null,
        instagramUrl: null,
      },
    ],
  });
});

it("saves independently chosen song and original-video volume levels with the selected track", async () => {
  const onSelect = vi.fn();
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <InstagramAudioCatalog
        type="music"
        video={video}
        connectionId={connectionId}
        postId={null}
        selected={null}
        onSelect={onSelect}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /Catalog song/ }));
  fireEvent.change(screen.getByRole("slider", { name: "Music volume" }), {
    target: { value: "25" },
  });
  fireEvent.change(screen.getByRole("slider", { name: "Original audio volume" }), {
    target: { value: "90" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Use audio" }));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith({
    sourceKey: video.key,
    connectionId,
    audioId: "587784541076604",
    title: "Catalog song",
    creator: "Artist",
    trackVolume: 25,
    originalVolume: 90,
  });
  expect(screen.getByText(/video preview keeps its original audio/)).toBeVisible();
});

it("restores both stored volume levels when editing the existing audio choice", async () => {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <InstagramAudioCatalog
        type="music"
        video={video}
        connectionId={connectionId}
        postId={null}
        selected={{
          sourceKey: video.key,
          connectionId,
          audioId: "587784541076604",
          title: "Catalog song",
          creator: "Artist",
          trackVolume: 15,
          originalVolume: 85,
        }}
        onSelect={vi.fn()}
      />
    </QueryClientProvider>,
  );
  expect(await screen.findByRole("slider", { name: "Music volume" })).toHaveValue("15");
  expect(screen.getByRole("slider", { name: "Original audio volume" })).toHaveValue("85");
});
