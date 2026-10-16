import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  connection: {} as Record<string, unknown>,
  previous: [] as Array<{
    provider_settings: Record<string, unknown>;
    post?: { body: string };
  }>,
  insights: [] as Array<{ caption: string | null }>,
  insightFilters: [] as Array<[string, unknown]>,
  publicProfiles: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          if (table === "social_content_insights") state.insightFilters.push([column, value]);
          return chain;
        },
        order: () => chain,
        limit: async () => ({
          data: table === "social_content_insights" ? state.insights : state.previous,
        }),
        maybeSingle: async () => ({
          data: table === "social_connections" ? state.connection : null,
          error: null,
        }),
      };
      return chain;
    },
  },
}));
vi.mock("./plan.server", () => ({ requirePlanEntitlement: vi.fn(async () => undefined) }));
vi.mock("./request-security.server", () => ({
  enforceRequestRateLimit: vi.fn(async () => undefined),
}));
vi.mock("./social-publisher.server", () => ({
  accessTokenForConnection: vi.fn(async () => "test-token"),
}));
vi.mock("./secret-crypto.server", () => ({ decryptServerSecret: vi.fn(async () => "user-token") }));
vi.mock("./social-mention-bright-data.server", () => ({
  searchBrightDataMentionProfiles: vi.fn(async () => ({
    items: state.publicProfiles,
    detail: null,
  })),
}));

import { searchBrightDataMentionProfiles } from "./social-mention-bright-data.server";
import { accessTokenForConnection } from "./social-publisher.server";
import { searchSocialMentionsForUser } from "./social-mentions.functions";

const connectionId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";

function useProvider(provider: string, scopes: string[] = []) {
  state.connection = {
    id: connectionId,
    provider,
    status: "active",
    reauth_required: false,
    scopes,
    access_token: "encrypted",
    facebook_user_access_token: "encrypted-user",
  };
}

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), { status: 200 });
}

describe("mention account lookup", () => {
  beforeEach(() => {
    state.previous = [];
    state.insights = [];
    state.insightFilters = [];
    state.publicProfiles = [];
    vi.mocked(searchBrightDataMentionProfiles).mockClear();
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("finds public X accounts without making paid X API reads", async () => {
    useProvider("twitter");
    state.publicProfiles = [
      {
        provider: "twitter",
        handle: "akash",
        id: "https://www.x.com/akash",
        name: "Akash",
        kind: "person",
        verified: false,
      },
    ];
    const result = await searchSocialMentionsForUser(userId, { connectionId, query: "aka" });
    expect(result.items[0]).toMatchObject({ handle: "akash", verified: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not search or suggest accounts before 3 letters", async () => {
    useProvider("twitter");
    state.insights = [
      { caption: "Thanks @ycombinator and @zach_yadegari" },
      { caption: "Another idea from @ycombinator" },
    ];

    const result = await searchSocialMentionsForUser(userId, { connectionId, query: "yc" });
    expect(result.items).toEqual([]);
    expect(result.detail).toContain("3 letters");
    expect(state.insightFilters).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("suggests handles from earlier scheduler posts when the indexed feed has none", async () => {
    useProvider("linkedin");
    state.previous = [{ provider_settings: {}, post: { body: "Thanks @Acme for the launch" } }];

    const result = await searchSocialMentionsForUser(userId, { connectionId, query: "Acm" });

    expect(result.items).toMatchObject([{ handle: "Acme", verified: false }]);
  });

  it("puts verified provider matches ahead of indexed handles without duplicating them", async () => {
    useProvider("twitter");
    state.insights = [{ caption: "Thanks @ycombinator and @zach_yadegari" }];
    state.publicProfiles = [
      {
        provider: "twitter",
        id: "https://www.x.com/ycombinator",
        handle: "ycombinator",
        name: "Y Combinator",
        kind: "person",
        verified: false,
      },
    ];

    const result = await searchSocialMentionsForUser(userId, { connectionId, query: "yco" });

    expect(result.items).toMatchObject([
      { handle: "ycombinator", verified: false, name: "Y Combinator" },
    ]);
  });

  it("limits even remembered X suggestions to three", async () => {
    useProvider("twitter");
    state.publicProfiles = Array.from({ length: 5 }, (_, index) => ({
      provider: "twitter",
      id: String(index),
      handle: `ycom${index}`,
      name: `Y Combinator ${index}`,
      kind: "person",
      verified: false,
    }));
    const result = await searchSocialMentionsForUser(userId, {
      connectionId,
      query: "ycom",
    });
    expect(result.items).toHaveLength(3);
  });

  it("falls back to indexed X handles when public search has no match", async () => {
    useProvider("twitter");
    state.insights = [{ caption: "Thanks @ycombinator" }];
    const result = await searchSocialMentionsForUser(userId, { connectionId, query: "yco" });
    expect(result.items[0]).toMatchObject({ handle: "ycombinator", verified: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows provider permission codes without exposing the provider response body", async () => {
    useProvider("facebook");
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 10, message: "Private provider detail" } }), {
        status: 403,
      }),
    );
    const result = await searchSocialMentionsForUser(userId, { connectionId, query: "Acme" });
    expect(result.detail).toContain("HTTP 403");
    expect(result.detail).toContain("provider code 10");
    expect(result.detail).not.toContain("Private provider detail");
  });

  it("does not offer invalid X handles as taggable accounts", async () => {
    useProvider("twitter");
    const result = await searchSocialMentionsForUser(userId, {
      connectionId,
      query: "first.last",
    });
    expect(result.items).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the person's encrypted Facebook token to find taggable Pages", async () => {
    useProvider("facebook");
    vi.mocked(fetch).mockResolvedValue(json({ data: [{ id: "123", name: "Acme" }] }));
    const result = await searchSocialMentionsForUser(userId, { connectionId, query: "Acme" });
    expect(result.items[0]).toMatchObject({ id: "123", kind: "page", verified: true });
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("access_token=user-token");
    expect(searchBrightDataMentionProfiles).not.toHaveBeenCalled();
  });

  it("uses the existing Meta app pair for older Facebook connections", async () => {
    useProvider("facebook");
    delete state.connection.facebook_user_access_token;
    vi.stubEnv("META_INSTAGRAM_APP_ID", "meta-app");
    vi.stubEnv("META_INSTAGRAM_APP_SECRET", "meta-secret");
    vi.mocked(fetch).mockResolvedValue(json({ data: [{ id: "123", name: "Acme" }] }));
    const result = await searchSocialMentionsForUser(userId, { connectionId, query: "Acme" });
    expect(result.items[0]).toMatchObject({ id: "123", kind: "page" });
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain(
      "access_token=meta-app%7Cmeta-secret",
    );
  });

  it("validates exact YouTube handles against the channel API", async () => {
    useProvider("youtube");
    vi.mocked(fetch).mockResolvedValue(
      json({ items: [{ id: "UC123", snippet: { title: "Acme Videos" } }] }),
    );
    const result = await searchSocialMentionsForUser(userId, { connectionId, query: "acme" });
    expect(result.items[0]).toMatchObject({ handle: "acme", id: "UC123", kind: "channel" });
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("forHandle=acme");
    expect(searchBrightDataMentionProfiles).not.toHaveBeenCalled();
  });

  it("uses Threads profile discovery only when that permission exists", async () => {
    useProvider("threads");
    expect(
      (await searchSocialMentionsForUser(userId, { connectionId, query: "acme" })).items,
    ).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    useProvider("threads", ["threads_profile_discovery"]);
    vi.mocked(fetch).mockResolvedValue(
      json({ username: "acme", name: "Acme", profile_picture_url: "https://example.com/p.jpg" }),
    );
    const result = await searchSocialMentionsForUser(userId, { connectionId, query: "acme" });
    expect(result.items[0]).toMatchObject({
      id: "acme",
      handle: "acme",
      avatarUrl: "https://example.com/p.jpg",
    });
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain(
      "graph.threads.com/v1.0/profile_lookup",
    );
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain(
      "fields=username%2Cname%2Cprofile_picture_url",
    );
  });

  it("resolves eligible Instagram professional usernames", async () => {
    useProvider("instagram");
    vi.stubEnv("INSTAGRAM_BUSINESS_ACCOUNT_ID", "178000");
    vi.stubEnv("INSTAGRAM_ACCESS_TOKEN", "business-token");
    vi.mocked(fetch).mockResolvedValue(
      json({
        business_discovery: {
          id: "178001",
          username: "acme",
          name: "Acme",
        },
      }),
    );
    const result = await searchSocialMentionsForUser(userId, { connectionId, query: "acme" });
    expect(result.items[0]).toMatchObject({ id: "178001", handle: "acme" });
  });

  it("looks up LinkedIn company identities for native annotations", async () => {
    useProvider("linkedin");
    vi.mocked(fetch).mockResolvedValue(
      json({ elements: [{ id: 42, vanityName: "acme", localizedName: "Acme" }] }),
    );
    const result = await searchSocialMentionsForUser(userId, { connectionId, query: "acme" });
    expect(result.items[0]).toMatchObject({ id: "urn:li:organization:42", kind: "page" });
  });

  it("suggests earlier TikTok handles without claiming platform verification", async () => {
    useProvider("tiktok");
    state.previous = [
      {
        provider_settings: {
          mentions: [
            {
              provider: "tiktok",
              id: "akash",
              name: "akash",
              handle: "akash",
              kind: "handle",
              verified: false,
            },
          ],
        },
      },
    ];
    const result = await searchSocialMentionsForUser(userId, { connectionId, query: "aka" });
    expect(result.items[0]).toMatchObject({ handle: "akash", verified: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows previously mentioned accounts after 3 letters", async () => {
    useProvider("twitter");
    state.previous = [
      {
        provider_settings: {
          mentions: [
            {
              provider: "twitter",
              id: "52",
              name: "Y Combinator",
              handle: "ycombinator",
              kind: "person",
              verified: true,
            },
          ],
        },
      },
    ];
    const result = await searchSocialMentionsForUser(userId, { connectionId, query: "yco" });
    expect(result.items[0]).toMatchObject({ handle: "ycombinator", verified: true });
    expect(fetch).not.toHaveBeenCalled();
  });
});

it("shows public search availability even when native authorization is missing", async () => {
  useProvider("linkedin");
  vi.mocked(accessTokenForConnection).mockRejectedValueOnce(new Error("missing token"));
  vi.mocked(searchBrightDataMentionProfiles).mockResolvedValueOnce({ items: [], detail: "Public account search is unavailable (HTTP 402)." });
  const result = await searchSocialMentionsForUser(userId, { connectionId, query: "microsoft" });
  expect(result.detail).toContain("HTTP 402");
});
