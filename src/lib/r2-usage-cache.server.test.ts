import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  row: null as { used_bytes: number; reconciled_at: string } | null,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: state.row, error: null }) }),
      }),
      upsert: async (row: { used_bytes: number; reconciled_at: string }) => {
        state.row = row;
        return { error: null };
      },
      delete: () => ({ eq: async () => ({ error: null }) }),
    }),
    rpc: async (_name: string, args: { p_delta: number }) => {
      if (state.row) state.row.used_bytes += args.p_delta;
      return { error: null };
    },
  },
}));

import { adjustCachedR2UserStorageBytes, cachedR2UserStorageBytes } from "./r2-usage-cache.server";

beforeEach(() => {
  state.row = null;
});

describe("R2 usage accounting", () => {
  it("scans once, counts a new import, then reuses the counter", async () => {
    const scan = vi.fn(async () => 100);
    const bucket = {} as R2Bucket;
    expect(await cachedR2UserStorageBytes(bucket, "owner", scan)).toBe(100);
    await adjustCachedR2UserStorageBytes("owner", 25);
    expect(await cachedR2UserStorageBytes(bucket, "owner", scan)).toBe(125);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("reconciles a stale counter from the bucket", async () => {
    state.row = {
      used_bytes: 125,
      reconciled_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    };
    const scan = vi.fn(async () => 90);
    expect(await cachedR2UserStorageBytes({} as R2Bucket, "owner", scan)).toBe(90);
    expect(scan).toHaveBeenCalledOnce();
  });
});
