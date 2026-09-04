import { afterEach, describe, expect, it, vi } from "vitest";
import { socialAccountProfiles } from "./social-oauth.functions";

describe("social account profiles", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refreshes one Facebook Page with the caller's bounded timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          id: "page/1",
          name: "Bento",
          picture: { data: { url: "https://scontent.example.fbcdn.net/avatar.jpg" } },
        }),
      ),
    );

    const [account] = await socialAccountProfiles("facebook", "page-token", "page/1", 5_000);

    expect(fetch).toHaveBeenCalledWith(
      "https://graph.facebook.com/v25.0/page%2F1?fields=id%2Cname%2Cpicture&access_token=page-token",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(account).toMatchObject({
      id: "page/1",
      avatar: "https://scontent.example.fbcdn.net/avatar.jpg",
    });
  });
});
