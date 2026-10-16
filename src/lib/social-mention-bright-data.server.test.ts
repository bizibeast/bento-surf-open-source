import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ cached: null as null | { items: unknown[] }, reserved: true }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        gt: () => chain,
        maybeSingle: async () => ({ data: state.cached }),
        upsert: async () => ({ error: null }),
      };
      return chain;
    },
    rpc: async () => ({ data: state.reserved, error: null }),
  },
}));
vi.mock("./request-security.server", () => ({
  readResponseText: async (response: Response) => response.text(),
}));

import {
  parseBrightDataMentionProfiles,
  searchBrightDataMentionProfiles,
} from "./social-mention-bright-data.server";

const organic = (rows: Array<{ link: string; title: string }>) => ({ organic: rows });

describe("Bright Data mention discovery", () => {
  beforeEach(() => {
    state.cached = null;
    state.reserved = true;
    vi.stubEnv("BRIGHT_DATA_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("keeps only direct public profiles for the selected network", () => {
    const rows = organic([
      { link: "https://x.com/ycombinator", title: "Y Combinator (@ycombinator) / X" },
      { link: "https://x.com/ycombinator/status/123", title: "Y Combinator post" },
      { link: "https://instagram.com/ycombinator", title: "Y Combinator" },
      { link: "https://x.com/ycombinator", title: "Duplicate" },
      { link: "https://evil.example/ycombinator", title: "Fake" },
    ]);
    expect(parseBrightDataMentionProfiles(rows, "twitter", "yco")).toMatchObject([
      { handle: "ycombinator", name: "Y Combinator", verified: false },
    ]);
  });

  it("searches profiles on all supported networks, with at most 3 suggestions", () => {
    const cases = [
      ["facebook", "https://facebook.com/acme", "Acme"],
      ["instagram", "https://instagram.com/acme", "Acme"],
      ["linkedin", "https://linkedin.com/in/acme", "Acme"],
      ["threads", "https://threads.com/@acme", "Acme"],
      ["tiktok", "https://tiktok.com/@acme", "Acme"],
      ["youtube", "https://youtube.com/@acme", "Acme"],
    ] as const;
    for (const [provider, link, title] of cases) {
      expect(
        parseBrightDataMentionProfiles(organic([{ link, title }]), provider, "acm"),
      ).toHaveLength(1);
    }
    expect(
      parseBrightDataMentionProfiles(
        organic(
          Array.from({ length: 8 }, (_, index) => ({
            link: `https://x.com/acme${index}`,
            title: `Acme ${index}`,
          })),
        ),
        "twitter",
        "acm",
      ),
    ).toHaveLength(3);
    expect(
      parseBrightDataMentionProfiles(
        organic([{ link: "https://youtube.com/channel/UC123", title: "Acme Videos" }]),
        "youtube",
        "acm",
      ),
    ).toEqual([]);
  });

  it("never charges Bright Data below 3 letters or after the monthly cap", async () => {
    expect((await searchBrightDataMentionProfiles("twitter", "ya")).items).toEqual([]);
    state.reserved = false;
    expect((await searchBrightDataMentionProfiles("twitter", "yas")).detail).toContain(
      "monthly limit",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses one bounded Bright Data SERP request for X instead of X reads", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify(
          organic([
            { link: "https://x.com/ycombinator", title: "Y Combinator (@ycombinator) / X" },
          ]),
        ),
        { status: 200 },
      ),
    );
    const result = await searchBrightDataMentionProfiles("twitter", "yco");
    expect(result.items[0]).toMatchObject({ handle: "ycombinator", verified: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe("https://api.brightdata.com/request");
  });
  it("reports a rejected upstream search without exposing the provider body", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({status_code: 403, body: "private provider detail"})));
    const result = await searchBrightDataMentionProfiles("twitter", "yco");
    expect(result.detail).toContain("upstream HTTP 403");
    expect(result.detail).not.toContain("private provider detail");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

});
