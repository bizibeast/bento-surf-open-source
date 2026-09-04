import { describe, expect, it } from "vitest";
import {
  SITEMAP_SHARD_SIZE,
  loadSitemapManifest,
  loadSitemapShard,
  parseSitemapShardPath,
  productSitemapEntries,
  profileSitemapEntries,
  renderSitemapIndex,
  renderSitemapUrlSet,
  type SitemapClient,
} from "./seo-sitemap.server";

const profile = {
  id: "creator-1",
  username: "coach",
  display_name: "Coach Maya",
  bio: "I help independent creators build sustainable businesses.",
  meta_description: null,
  avatar_url: null,
  updated_at: "2026-08-20T12:00:00Z",
  onboarded: true,
  noindex: false,
  plan_id: "creator",
  is_pro: true,
  has_public_content: true,
};

const product = {
  id: "product-1",
  creator_id: "creator-1",
  creator_username: "coach",
  creator_onboarded: true,
  creator_noindex: false,
  creator_plan_id: "creator",
  creator_is_pro: true,
  public_slug: "creator-course",
  title: "Creator business course",
  description: "A practical course for building a durable creator business.",
  kind: "course",
  status: "published",
  noindex: false,
  updated_at: "2026-08-22T12:00:00Z",
};

type QueryResponse = {
  data: unknown;
  error: { message?: string } | null;
  count?: number | null;
};

type QueryCall = {
  table: string;
  columns?: string;
  options?: { count?: string; head?: boolean };
  filters: Array<[string, string, unknown]>;
  range?: [number, number];
};

class FakeQuery implements PromiseLike<QueryResponse> {
  constructor(
    private readonly call: QueryCall,
    private readonly respond: (call: QueryCall) => QueryResponse,
  ) {}

  select(columns: string, options?: { count?: string; head?: boolean }) {
    this.call.columns = columns;
    this.call.options = options;
    return this;
  }

  eq(column: string, value: unknown) {
    this.call.filters.push(["eq", column, value]);
    return this;
  }

  in(column: string, value: unknown[]) {
    this.call.filters.push(["in", column, value]);
    return this;
  }

  order(column: string, options?: unknown) {
    this.call.filters.push(["order", column, options]);
    return this;
  }

  range(from: number, to: number) {
    this.call.range = [from, to];
    return Promise.resolve(this.respond(this.call));
  }

  then<TResult1 = QueryResponse, TResult2 = never>(
    onfulfilled?: ((value: QueryResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.respond(this.call)).then(onfulfilled, onrejected);
  }
}

function fakeClient(respond: (call: QueryCall) => QueryResponse) {
  const calls: QueryCall[] = [];
  const client = {
    from(table: string) {
      const call: QueryCall = { table, filters: [] };
      calls.push(call);
      return new FakeQuery(call, respond);
    },
  } as unknown as SitemapClient;
  return { calls, client };
}

describe("sitemap quality gates", () => {
  it("includes only eligible profiles with a display name and substantive content", () => {
    const entries = profileSitemapEntries([
      profile,
      {
        ...profile,
        id: "meta",
        username: "meta",
        bio: "",
        meta_description: "A useful profile summary with enough detail.",
      },
      {
        ...profile,
        id: "avatar",
        username: "avatar",
        bio: "",
        avatar_url: "https://cdn.bento.surf/avatar.jpg",
        has_public_content: false,
      },
      {
        ...profile,
        id: "blocks",
        username: "blocks",
        bio: "",
        meta_description: "",
        avatar_url: null,
        has_public_content: true,
      },
      { ...profile, id: "no-name", username: "no-name", display_name: "" },
      {
        ...profile,
        id: "thin",
        username: "thin",
        bio: "Too short",
        has_public_content: false,
      },
      {
        ...profile,
        id: "bad-avatar",
        username: "bad-avatar",
        bio: "",
        avatar_url: "javascript:alert(1)",
        has_public_content: false,
      },
      { ...profile, id: "hidden", username: "hidden", noindex: true },
      { ...profile, id: "draft", username: "draft", onboarded: false },
    ]);

    expect(entries.map((entry) => entry.loc)).toEqual([
      "http://localhost:8080/@coach",
      "http://localhost:8080/@meta",
      "http://localhost:8080/@blocks",
    ]);
    expect(entries[0]?.lastmod).toBe("2026-08-20T12:00:00.000Z");
  });

  it("emits only the creator root even when secondary creator pages are enabled", () => {
    const profileWithSecondaryPages = {
      ...profile,
      calendar_page_enabled: true,
      social_insights_enabled: true,
      store_page_enabled: true,
    };
    const entries = profileSitemapEntries([profileWithSecondaryPages]);

    expect(entries.map((entry) => entry.loc)).toEqual(["http://localhost:8080/@coach"]);
  });

  it("includes only substantive, search-enabled, entitled published products", () => {
    const entries = productSitemapEntries([
      product,
      { ...product, public_slug: "hidden", noindex: true },
      { ...product, public_slug: "draft", status: "draft" },
      { ...product, public_slug: "thin-title", title: "A" },
      { ...product, public_slug: "thin-description", description: "Too short" },
      {
        ...product,
        creator_id: "free",
        creator_username: "free",
        creator_plan_id: "free",
        creator_is_pro: false,
        public_slug: "unentitled",
      },
    ]);

    expect(entries.map((entry) => entry.loc)).toEqual([
      "http://localhost:8080/@coach/products/creator-course",
    ]);
  });
});

describe("sitemap XML", () => {
  it("renders the required numbered creator and product shards", () => {
    const xml = renderSitemapIndex({ profiles: 1_001, products: 1 });

    expect(Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g), (match) => match[1])).toEqual([
      "http://localhost:8080/sitemaps/profiles-0001.xml",
      "http://localhost:8080/sitemaps/profiles-0002.xml",
      "http://localhost:8080/sitemaps/products-0001.xml",
    ]);
  });

  it("parses only valid one-based profile and product shard paths", () => {
    expect(parseSitemapShardPath("/sitemaps/profiles-0002.xml")).toEqual({
      kind: "profiles",
      shard: 2,
    });
    expect(parseSitemapShardPath("/sitemaps/products-10000.xml")).toEqual({
      kind: "products",
      shard: 10_000,
    });
    expect(parseSitemapShardPath("/sitemaps/profiles-0000.xml")).toBeNull();
    expect(parseSitemapShardPath("/sitemaps/profiles-1.xml")).toBeNull();
    expect(parseSitemapShardPath("/sitemaps/calendar-0001.xml")).toBeNull();
  });

  it("renders escaped URL entries and never exceeds the shard limit", () => {
    const xml = renderSitemapUrlSet([
      { loc: "https://bento.surf/@a?x=1&y=2", lastmod: "2026-08-20T12:00:00.000Z" },
      ...Array.from({ length: SITEMAP_SHARD_SIZE }, (_, index) => ({
        loc: `https://bento.surf/@creator-${index}`,
      })),
    ]);

    expect(xml).toContain("https://bento.surf/@a?x=1&amp;y=2");
    expect(xml.match(/<url>/g)).toHaveLength(SITEMAP_SHARD_SIZE);
  });
});

describe("sitemap database loading", () => {
  it("builds the manifest with exact head-only counts", async () => {
    const { calls, client } = fakeClient((call) => ({
      data: null,
      error: null,
      count: call.table === "sitemap_profiles" ? 20_001 : 9_999,
    }));

    await expect(loadSitemapManifest(client)).resolves.toEqual({
      profiles: 20_001,
      products: 9_999,
    });
    expect(calls.map((call) => [call.table, call.options])).toEqual([
      ["sitemap_profiles", { count: "exact", head: true }],
      ["sitemap_products", { count: "exact", head: true }],
    ]);
  });

  it("fails closed when an exact manifest count is unavailable", async () => {
    const { client } = fakeClient(() => ({ data: null, error: null, count: null }));

    await expect(loadSitemapManifest(client)).rejects.toThrow("count unavailable");
  });

  it("loads one bounded profile shard and applies the quality gate", async () => {
    const { calls, client } = fakeClient((call) => ({
      data:
        call.table === "sitemap_profiles"
          ? [
              profile,
              {
                ...profile,
                id: "thin",
                username: "thin",
                bio: "Short",
                has_public_content: false,
              },
            ]
          : [],
      error: null,
    }));

    await expect(loadSitemapShard("profiles", 2, client)).resolves.toEqual([
      { loc: "http://localhost:8080/@coach", lastmod: "2026-08-20T12:00:00.000Z" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.range).toEqual([1_000, 1_999]);
  });

  it("caps each database read at the 1,000 URL shard boundary", async () => {
    const { calls, client } = fakeClient((call) => {
      const from = call.range?.[0] || 0;
      return {
        data: Array.from({ length: 1_000 }, (_, index) => ({
          ...profile,
          id: `creator-${from + index}`,
          username: `creator-${from + index}`,
        })),
        error: null,
      };
    });

    await expect(loadSitemapShard("profiles", 1, client)).resolves.toHaveLength(1_000);
    expect(calls.map((call) => call.range)).toEqual([[0, 999]]);
  });

  it("loads one bounded product shard and only its related creators", async () => {
    const { calls, client } = fakeClient((call) => {
      if (call.table === "sitemap_products") return { data: [product], error: null };
      return { data: [], error: null };
    });

    await expect(loadSitemapShard("products", 3, client)).resolves.toEqual([
      {
        loc: "http://localhost:8080/@coach/products/creator-course",
        lastmod: "2026-08-22T12:00:00.000Z",
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.range).toEqual([2_000, 2_999]);
  });
});
