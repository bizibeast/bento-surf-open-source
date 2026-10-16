import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishX } from "./social-publisher.server";
import { reserveProviderUsage, ProviderBudgetError } from "./provider-budget.server";

describe("publishing to X communities", () => {
  beforeEach(() => {
    vi.mocked(reserveProviderUsage).mockReset().mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ data: { id: "99" } }, { status: 201 })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends the selected community with the normal budgeted create request", async () => {
    await expect(
      publishX(
        "test-token",
        "For builders",
        [],
        "",
        { xCommunity: { id: "https://x.com/i/communities/1234567890123456789", name: "Builders" } },
        {},
      ),
    ).resolves.toMatchObject({ id: "99" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.x.com/2/tweets",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ text: "For builders", community_id: "1234567890123456789" }),
      }),
    );
    expect(reserveProviderUsage).toHaveBeenCalledWith("x_write_actions");
  });

  it("keeps Everyone posts unchanged", async () => {
    await publishX("test-token", "For everyone", [], "", { xCommunity: null }, {});
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({
      text: "For everyone",
    });
  });

  it("keeps image attachments on a community post", async () => {
    vi.mocked(fetch).mockImplementation(async (url) => {
      if (url === "https://bento.surf/photo.jpg")
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/jpeg", "content-length": "3" },
        });
      if (String(url).includes("/media/upload")) return Response.json({ data: { id: "55" } });
      return Response.json({ data: { id: "99" } }, { status: 201 });
    });
    await publishX(
      "test-token",
      "With a photo",
      [
        {
          key: "photo.jpg",
          url: "https://bento.surf/photo.jpg",
          name: "photo.jpg",
          mimeType: "image/jpeg",
          size: 3,
        },
      ],
      "",
      { xCommunity: { id: "123" } },
      {},
    );
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body))).toEqual({
      text: "With a photo",
      media: { media_ids: ["55"] },
      community_id: "123",
    });
  });

  it.each([{ id: "" }, { id: "https://evil.test/i/communities/123" }])(
    "blocks invalid communities before any network request: %s",
    async (xCommunity) => {
      await expect(
        publishX("test-token", "Post", [], "", { xCommunity }, {}),
      ).rejects.toMatchObject({ code: "community_invalid", retryable: false });
      expect(fetch).not.toHaveBeenCalled();
      expect(reserveProviderUsage).not.toHaveBeenCalled();
    },
  );

  it("does not silently publish to Everyone or retry after a membership rejection", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ detail: "You are not a member of this community" }, { status: 403 }),
    );
    await expect(
      publishX("test-token", "Post", [], "", { xCommunity: { id: "123" } }, {}),
    ).rejects.toMatchObject({ status: 403, retryable: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("makes no X request when the paid write budget is exhausted", async () => {
    vi.mocked(reserveProviderUsage).mockRejectedValueOnce(
      new ProviderBudgetError("x_write_actions"),
    );
    await expect(
      publishX("test-token", "Post", [], "", { xCommunity: { id: "123" } }, {}),
    ).rejects.toMatchObject({ code: "budget_exhausted", retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});
