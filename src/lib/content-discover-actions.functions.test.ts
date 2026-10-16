import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  from: vi.fn(),
  eq: vi.fn(),
  update: vi.fn(),
  upsert: vi.fn(),
  workspace: vi.fn(),
  rate: vi.fn(),
  follows: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (handler: unknown) => handler,
  createServerFn: () => {
    let validate = (input: unknown) => input;
    const chain: Record<string, unknown> = {};
    chain.middleware = () => chain;
    chain.validator = (fn: typeof validate) => {
      validate = fn;
      return chain;
    };
    chain.handler = (fn: (input: unknown) => unknown) => (input: { data: unknown }) =>
      fn({ context: { userId: "owner" }, data: validate(input.data) });
    return chain;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      mocks.from(table);
      const query = {
        select: vi.fn(),
        eq: vi.fn(),
        update: vi.fn(),
        upsert: vi.fn(),
        maybeSingle: mocks.read,
        single: mocks.read,
      };
      query.select.mockReturnValue(query);
      for (const key of ["eq", "update", "upsert"] as const)
        query[key].mockImplementation((...args) => {
          mocks[key](...args);
          return query;
        });
      return query;
    },
  },
}));
vi.mock("./content-access.server", () => ({ requireContentWorkspace: mocks.workspace }));
vi.mock("./content-discover-follows.server", () => ({
  readDiscoverFollows: mocks.follows,
  researchDiscoverFollows: vi.fn(),
}));
vi.mock("./request-security.server", async (original) => ({
  ...(await original<typeof import("./request-security.server")>()),
  enforceRequestRateLimit: mocks.rate,
}));
import {
  trackDiscoverCreator,
  untrackDiscoverCreator,
  unsaveDiscoverItem,
} from "./content-discovery.functions";
const id = "11111111-1111-4111-8111-111111111111";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspace.mockResolvedValue("owner");
  mocks.rate.mockResolvedValue(undefined);
  mocks.follows.mockResolvedValue([]);
});

it("unsaves only an owned recommendation, preserving its metadata, like and Brain copy", async () => {
  mocks.read
    .mockResolvedValueOnce({
      data: { feedback: "liked", metadata: { saved: true, author: "Alice" } },
    })
    .mockResolvedValueOnce({ data: { id } });
  await expect(unsaveDiscoverItem({ data: { id } })).resolves.toMatchObject({
    saved: false,
    feedback: "liked",
  });
  expect(mocks.update).toHaveBeenCalledWith(
    expect.objectContaining({ feedback: "liked", metadata: { saved: false, author: "Alice" } }),
  );
  expect(mocks.eq.mock.calls.filter(([key]) => key === "user_id")).toEqual([
    ["user_id", "owner"],
    ["user_id", "owner"],
  ]);
  expect(
    mocks.from.mock.calls.every(([table]) => table === "creator_content_recommendations"),
  ).toBe(true);
});

it("rejects missing or foreign recommendations before any unsave write", async () => {
  mocks.read.mockResolvedValueOnce({ data: null });
  await expect(unsaveDiscoverItem({ data: { id } })).rejects.toThrow("could not be found");
  expect(mocks.update).not.toHaveBeenCalled();
});

it("persists a normalized favorite under the authenticated workspace and soft-untracks it", async () => {
  mocks.read.mockResolvedValue({ data: { id } });
  await trackDiscoverCreator({
    data: { profileUrl: "https://facebook.com/founder/", topics: "Startup lessons" },
  });
  expect(mocks.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      user_id: "owner",
      profile_url: "https://www.facebook.com/founder",
      platform: "Facebook",
      active: true,
    }),
    { onConflict: "user_id,profile_url" },
  );
  await untrackDiscoverCreator({ data: { id } });
  expect(mocks.update).toHaveBeenCalledWith({ active: false });
  expect(mocks.eq).toHaveBeenCalledWith("user_id", "owner");
});

it("enforces workspace access and the favorite limit before writing", async () => {
  mocks.workspace.mockRejectedValueOnce(new Error("Access denied"));
  await expect(
    trackDiscoverCreator({ data: { profileUrl: "https://reddit.com/r/startups" } }),
  ).rejects.toThrow("Access denied");
  mocks.follows.mockResolvedValueOnce(
    Array.from({ length: 25 }, (_, n) => ({ profileUrl: `https://reddit.com/r/${n}` })),
  );
  await expect(
    trackDiscoverCreator({ data: { profileUrl: "https://reddit.com/r/startups" } }),
  ).rejects.toThrow("25 creators");
  expect(mocks.upsert).not.toHaveBeenCalled();
});
