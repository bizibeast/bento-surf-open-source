import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ filters: [] as unknown[][] }));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const query: any = {
      select: () => query,
      eq: (...args: unknown[]) => {
        mocks.filters.push(args);
        return query;
      },
      is: (...args: unknown[]) => {
        mocks.filters.push(args);
        return query;
      },
      then: (resolve: any) => Promise.resolve({ count: 2, error: null }).then(resolve),
    };
    const fn: any = {
      middleware: () => fn,
      handler: (handler: any) => () =>
        handler({ context: { userId: "owner", supabase: { from: () => query } } }),
    };
    return fn;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("./plan.server", () => ({ getPlan: vi.fn().mockResolvedValue("free") }));
vi.mock("./r2-storage.server", () => ({
  getMediaBucket: vi.fn(),
  sumR2UserStorageBytes: vi.fn().mockResolvedValue(0),
}));
import { getMyUsage, loadUsage } from "./usage.functions";

const ok = (count: number) => Promise.resolve({ count, error: null });

describe("settings usage snapshot", () => {
  it("counts only custom hosted pages in the live usage query", async () => {
    mocks.filters.length = 0;
    await getMyUsage();
    expect(mocks.filters).toContainEqual(["system", null]);
    expect(mocks.filters).toContainEqual(["url", null]);
  });
  it("includes Main in page usage and falls back to zero when R2 is unavailable", async () => {
    const usage = await loadUsage({
      countPages: () => ok(1),
      countBlocks: () => ok(7),
      isPro: async () => false,
      storageBytes: () => {
        throw new Error("Cloudflare R2 is not configured");
      },
    });

    expect(usage).toMatchObject({
      isPro: false,
      pages: 2,
      pageLimit: 5,
      blocks: 7,
      storageBytes: 0,
    });
  });

  it("keeps database errors visible even when storage also fails", async () => {
    const blocks = vi.fn(() => ok(3));

    await expect(
      loadUsage({
        countPages: async () => ({ count: null, error: { message: "pages unavailable" } }),
        countBlocks: blocks,
        isPro: async () => false,
        storageBytes: async () => {
          throw new Error("R2 unavailable");
        },
      }),
    ).rejects.toThrow("pages unavailable");
    expect(blocks).toHaveBeenCalledOnce();
  });

  it("uses the five-page visible limit for Free", async () => {
    const usage = await loadUsage({
      countPages: () => ok(4),
      countBlocks: () => ok(12),
      plan: async () => "free",
      storageBytes: async () => 42,
    });

    expect(usage.pages).toBe(5);
    expect(usage.pageLimit).toBe(5);
    expect(usage.storageBytes).toBe(42);
  });

  it("uses an unlimited visible page limit for Store", async () => {
    const usage = await loadUsage({
      countPages: () => ok(9),
      countBlocks: () => ok(30),
      plan: async () => "store",
      storageBytes: async () => 99,
    });

    expect(usage.plan).toBe("store");
    expect(usage.pages).toBe(10);
    expect(usage.pageLimit).toBeNull();
  });
});
