import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  eq: vi.fn(),
  read: vi.fn(),
  workspace: vi.fn(),
  rate: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (handler: unknown) => handler,
  createServerFn: () => {
    let validate = (data: unknown) => data;
    const chain: Record<string, unknown> = {};
    chain.middleware = () => chain;
    chain.validator = (fn: (value: unknown) => unknown) => {
      validate = fn;
      return chain;
    };
    chain.handler =
      (fn: (input: { context: { userId: string }; data: unknown }) => unknown) =>
      (input: { data: unknown }) =>
        fn({ context: { userId: "current-workspace" }, data: validate(input.data) });
    return chain;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: mocks.read };
      query.select.mockReturnValue(query);
      query.eq.mockImplementation((...args) => {
        mocks.eq(...args);
        return query;
      });
      return query;
    },
  },
}));
vi.mock("./content-access.server", () => ({ requireContentWorkspace: mocks.workspace }));
vi.mock("./request-security.server", async (original) => ({
  ...(await original<typeof import("./request-security.server")>()),
  enforceRequestRateLimit: mocks.rate,
}));
vi.mock("./content-discover-creator.server", () => ({ resolveDiscoverCreator: mocks.resolve }));
import { getDiscoverCreator } from "./content-discovery.functions";
const id = "11111111-1111-4111-8111-111111111111";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspace.mockResolvedValue("creator");
  mocks.rate.mockResolvedValue(undefined);
  mocks.read.mockResolvedValue({
    data: {
      id,
      title: "A post",
      kind: "trend",
      fingerprint: "post",
      source_url: "https://www.instagram.com/reel/Abcdef123/",
      metadata: { platform: "Instagram" },
      feedback: "pending",
    },
    error: null,
  });
  mocks.resolve.mockResolvedValue({
    author: "Creator",
    authorUrl: "https://www.instagram.com/creator/",
    authorAvatarUrl: "https://app.bento.surf/cdn/discover/creator.jpg",
  });
});
it("scopes creator resolution to a recommendation in the authenticated workspace", async () => {
  await getDiscoverCreator({ data: { id } });
  expect(mocks.workspace).toHaveBeenCalledWith("current-workspace", "discover");
  expect(mocks.eq).toHaveBeenCalledWith("user_id", "current-workspace");
  expect(mocks.eq).toHaveBeenCalledWith("id", id);
  expect(mocks.resolve).toHaveBeenCalledWith(
    expect.objectContaining({ id, sourceUrl: "https://www.instagram.com/reel/Abcdef123/" }),
  );
});
it("does not fetch another workspace's or a deleted recommendation", async () => {
  mocks.read.mockResolvedValueOnce({ data: null, error: null });
  await expect(getDiscoverCreator({ data: { id } })).rejects.toThrow("could not be loaded");
  expect(mocks.resolve).not.toHaveBeenCalled();
});
it("stops public provider requests at the existing rate limit", async () => {
  mocks.rate.mockRejectedValueOnce(new Error("Too many requests"));
  await expect(getDiscoverCreator({ data: { id } })).rejects.toThrow("Too many requests");
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.resolve).not.toHaveBeenCalled();
});
