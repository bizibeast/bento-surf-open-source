import { cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SchedulerConnection } from "@/lib/social-scheduler";
import { PreviewAvatar, ProviderPostPreview } from "./ProviderPostPreview";

const connection = (provider: SchedulerConnection["provider"]): SchedulerConnection => ({
  id: provider,
  provider,
  handle: "bizibeast",
  displayName: "Bizibeast",
  avatarUrl: null,
  status: "active",
  connectedAt: "2026-08-24T00:00:00.000Z",
  canPublish: true,
  publishBlockReason: null,
});

const props = {
  body: "Post copy",
  title: "Post title",
  media: [
    {
      key: "image",
      url: "/marketing/scheduler-workspace.webp",
      name: "Creator workspace",
      mimeType: "image/webp",
      size: 24_000,
    },
  ],
  youtubeThumbnail: null,
  youtubeFormat: "video" as const,
  instagramCover: null,
  tiktokPrivacy: "PUBLIC_TO_EVERYONE",
  youtubePrivacy: "public",
  redditCommunity: "creators",
  redditKind: "self" as const,
  redditUrl: "",
};

describe("ProviderPostPreview", () => {
  afterEach(() => cleanup());

  it("keeps the real platform media proportions instead of stretching one generic frame", () => {
    const markup = (provider: SchedulerConnection["provider"]) =>
      renderToStaticMarkup(<ProviderPostPreview {...props} connection={connection(provider)} />);

    expect(markup("instagram")).toContain("aspect-square");
    expect(markup("facebook")).toContain("aspect-[4/3]");
    expect(markup("twitter")).toContain("aspect-video");
    expect(markup("tiktok")).toContain("aspect-[9/16]");
    expect(markup("tiktok")).toContain("object-contain");
  });

  it("falls back to the provider mark when a remote avatar is blocked or expired", () => {
    const instagram = {
      ...connection("instagram"),
      avatarUrl: "https://scontent.example/avatar.jpg",
    };
    const onError = vi.fn();
    const { container } = render(<PreviewAvatar connection={instagram} onError={onError} />);
    const image = container.querySelector("img");

    expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
    fireEvent.error(image!);
    expect(onError).toHaveBeenCalledOnce();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("reports an expired avatar from every provider preview", () => {
    const instagram = {
      ...connection("instagram"),
      avatarUrl: "https://scontent.example/avatar.jpg",
    };
    const onAvatarError = vi.fn();
    const { container } = render(
      <ProviderPostPreview {...props} connection={instagram} onAvatarError={onAvatarError} />,
    );

    fireEvent.error(container.querySelector("img")!);
    expect(onAvatarError).toHaveBeenCalledOnce();
  });
});
