import { describe, expect, it, vi } from "vitest";
import { resolveDiscoverCreator } from "./content-discover-creator.server";
import { CreatorIdentity } from "@/components/content/DiscoverPost";
import { render, waitFor } from "@testing-library/react";
import type { DiscoverRecommendation } from "./content-discovery.functions";

const post = {
  id: "post",
  title: "A post",
  sourceUrl: "https://www.instagram.com/reel/Abcdef123/",
  platform: "Instagram",
  author: "Creator",
  authorUrl: "https://www.instagram.com/creator/",
  sourcePublishedAt: null,
} as DiscoverRecommendation;
const photo = {
  author: "Creator",
  authorUrl: post.authorUrl,
  authorAvatarUrl: "https://scontent.cdninstagram.com/avatar.jpg",
};
const dependencies = () => ({
  read: vi.fn().mockResolvedValue(null),
  write: vi.fn().mockResolvedValue(undefined),
  enrich: vi.fn().mockResolvedValue([{ ...photo }]),
  persistPhoto: vi.fn().mockResolvedValue("https://app.bento.surf/cdn/discover/avatar.jpg"),
});

describe("Discover creator recovery", () => {
  it("resolves a missing avatar independently and caches a durable image URL", async () => {
    const deps = dependencies();
    const result = await resolveDiscoverCreator(post, deps);
    expect(result.authorAvatarUrl).toBe("https://app.bento.surf/cdn/discover/avatar.jpg");
    expect(deps.persistPhoto).toHaveBeenCalledWith(
      "instagram",
      photo.authorUrl,
      photo.authorAvatarUrl,
    );
    expect(deps.write).toHaveBeenCalledWith(expect.any(String), result, expect.any(Number));
  });
  it("reuses cached creator data without repeating external requests", async () => {
    const deps = dependencies();
    deps.read.mockResolvedValue(photo);
    expect(await resolveDiscoverCreator(post, deps)).toEqual(photo);
    expect(deps.enrich).not.toHaveBeenCalled();
  });
  it("does not lose an existing avatar during a transient provider failure", async () => {
    const deps = dependencies();
    deps.enrich.mockRejectedValue(new Error("temporary failure"));
    const result = await resolveDiscoverCreator(
      { ...post, authorAvatarUrl: photo.authorAvatarUrl },
      deps,
    );
    expect(result.authorAvatarUrl).toBe(photo.authorAvatarUrl);
  });
  it("requests missing pictures from a visible creator identity", async () => {
    const resolve = vi.fn().mockResolvedValue(photo);
    render(<CreatorIdentity item={post} now={new Date()} onResolveCreator={resolve} />);
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(post));
    await waitFor(() =>
      expect(document.querySelector(".discover-avatar img")).toHaveAttribute(
        "src",
        photo.authorAvatarUrl,
      ),
    );
  });
});
