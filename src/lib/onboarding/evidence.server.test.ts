import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  queries: [] as Array<{ table: string; columns: string; filters: unknown[][]; limit?: number }>,
  connections: [] as Array<Record<string, unknown>>,
}));
vi.mock("./session.server", () => ({
  onboardingDb: {
    from: (table: string) => {
      const call = {
        table,
        columns: "",
        filters: [] as unknown[][],
        limit: undefined as number | undefined,
      };
      mocks.queries.push(call);
      const q: Record<string, ReturnType<typeof vi.fn>> = {};
      q.select = vi.fn((columns: string) => {
        call.columns = columns;
        return q;
      });
      for (const key of ["eq", "in", "not", "neq", "gte", "order"])
        q[key] = vi.fn((...args: unknown[]) => {
          call.filters.push([key, ...args]);
          return q;
        });
      q.limit = vi.fn(async (limit: number) => {
        call.limit = limit;
        return {
          error: null,
          data:
            table === "social_connections"
              ? mocks.connections
              : table === "creator_content_recommendations"
                ? []
                : [
                    { id: "older", provider: "linkedin", engagements: 12 },
                    { id: "standout", provider: "linkedin", engagements: 40 },
                  ],
        };
      });
      q.maybeSingle = vi.fn(async () => ({
        error: null,
        data: {
          id: "standout",
          provider: "linkedin",
          engagements: 40,
          caption: "A useful post from the connected account.",
          remote_post_url: "https://www.linkedin.com/feed/update/standout",
        },
      }));
      return q;
    },
  },
}));
import { loadOnboardingEvidence } from "./evidence.server";
beforeEach(() => {
  mocks.queries.length = 0;
  mocks.connections = [
    { id: "owned-connection", provider: "linkedin", provider_display_name: "Ari" },
  ];
});

it("scopes every read to the workspace and fetches only the winning caption", async () => {
  const result = await loadOnboardingEvidence("workspace");
  expect(result.standout).toMatchObject({ id: "standout", comparedPosts: 2, engagements: 40 });
  expect(result.postCount).toBe(2);
  for (const call of mocks.queries)
    expect(call.filters).toContainEqual(["eq", "user_id", "workspace"]);
  const posts = mocks.queries.filter((call) => call.table === "social_content_insights");
  expect(posts[0].columns).not.toContain("caption");
  expect(posts[0].limit).toBe(120);
  expect(posts[1].filters).toContainEqual(["eq", "id", "standout"]);
  for (const call of posts)
    expect(call.filters).toContainEqual(["in", "connection_id", ["owned-connection"]]);
});

it("does not query post or inspiration history when no active account is connected", async () => {
  mocks.connections = [];
  expect(await loadOnboardingEvidence("workspace")).toEqual({
    profiles: [],
    postCount: 0,
    standout: null,
    inspirations: [],
  });
  expect(mocks.queries).toHaveLength(1);
});
