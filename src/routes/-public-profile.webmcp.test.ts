import { afterEach, describe, expect, it, vi } from "vitest";
import { openPublicCreatorPageFromWebMcp } from "@/lib/webmcp";

describe("public creator page WebMCP navigation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("requires approval and honors cancellation before navigation", async () => {
    const openPage = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const pages = [{ name: "Store", slug: "store", url: null }];

    await expect(
      openPublicCreatorPageFromWebMcp(
        { slug: "store" },
        pages,
        new AbortController().signal,
        openPage,
      ),
    ).rejects.toThrow("did not approve");
    expect(openPage).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    const controller = new AbortController();
    controller.abort();
    await expect(
      openPublicCreatorPageFromWebMcp({ slug: "store" }, pages, controller.signal, openPage),
    ).rejects.toThrow();
    expect(openPage).not.toHaveBeenCalled();

    await expect(
      openPublicCreatorPageFromWebMcp(
        { slug: "store" },
        pages,
        new AbortController().signal,
        openPage,
      ),
    ).resolves.toMatchObject({ structuredContent: { slug: "store" } });
    expect(openPage).toHaveBeenCalledWith({ name: "Store", slug: "store" });
  });
});
