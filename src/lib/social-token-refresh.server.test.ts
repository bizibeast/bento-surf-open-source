/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ row: {} as any, lease: false, fail: false, rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: db.rpc,
    from() {
      let update: any;
      const filters: [string, unknown][] = [];
      const result = () => {
        const match = filters.every(([key, value]) => db.row[key] === value);
        if (update && match) Object.assign(db.row, update);
        return {
          data: match ? { ...db.row } : null,
          error: db.fail ? new Error("db unavailable") : null,
        };
      };
      const chain: any = {
        select: () => chain,
        eq: (key: string, value: unknown) => {
          filters.push([key, value]);
          return chain;
        },
        update: (value: unknown) => {
          update = value;
          return chain;
        },
        maybeSingle: async () => result(),
        then: (resolve: any) => Promise.resolve(result()).then(resolve),
      };
      return chain;
    },
  },
}));
vi.mock("./secret-crypto.server", () => ({ decryptServerSecret: async (value: string) => value }));
import { withSocialTokenRefresh } from "./social-token-refresh.server";
import { ProviderError, needsSocialReconnect } from "./social-provider-error";
beforeEach(() => {
  db.row = {
    id: crypto.randomUUID(),
    user_id: "owner",
    provider: "twitter",
    access_token: "old",
    refresh_token: "refresh",
    status: "active",
    token_expires_at: new Date(Date.now() - 1000).toISOString(),
  };
  db.fail = false;
  db.lease = false;
  db.rpc.mockReset().mockImplementation(async () => ({ data: !db.lease, error: null }));
});
function refreshed() {
  Object.assign(db.row, {
    access_token: "new",
    refresh_token: "rotated",
    token_expires_at: new Date(Date.now() + 7_200_000).toISOString(),
    status: "active",
  });
  return "new";
}
describe("rotating social token refresh", () => {
  it("shares one renewal between concurrent requests and updates caller state", async () => {
    const first = { ...db.row },
      second = { ...db.row };
    const refresh = vi.fn(async () => refreshed());
    expect(
      await Promise.all([
        withSocialTokenRefresh(first, refresh),
        withSocialTokenRefresh(second, refresh),
      ]),
    ).toEqual(["new", "new"]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(first.access_token).toBe("new");
    expect(second.refresh_token).toBe("rotated");
  });
  it("reloads a newer saved token instead of refreshing an obsolete caller token", async () => {
    const stale = { ...db.row };
    refreshed();
    const refresh = vi.fn();
    expect(await withSocialTokenRefresh(stale, refresh, true)).toBe("new");
    expect(refresh).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it("forces renewal when a still-current access token is rejected", async () => {
    db.row.token_expires_at = new Date(Date.now() + 7_200_000).toISOString();
    const refresh = vi.fn(async () => refreshed());
    expect(await withSocialTokenRefresh({ ...db.row }, refresh, true)).toBe("new");
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it("defers when another Worker holds the database lease", async () => {
    db.lease = true;
    const refresh = vi.fn();
    await expect(withSocialTokenRefresh({ ...db.row }, refresh)).rejects.toMatchObject({
      code: "refresh_in_progress",
      retryable: true,
    });
    expect(refresh).not.toHaveBeenCalled();
  });
  it.each(["revoked", "missing"])("never renews a %s connection", async (status) => {
    const original = { ...db.row };
    if (status === "missing") db.row = {};
    else db.row.status = status;
    const refresh = vi.fn();
    await expect(withSocialTokenRefresh(original, refresh)).rejects.toMatchObject({
      code: "reconnect_required",
    });
    expect(refresh).not.toHaveBeenCalled();
  });
  it("does not return an unsaved renewal or silently reuse old credentials after a DB error", async () => {
    const refresh = vi.fn(async () => {
      throw new ProviderError("save failed", "refresh_save_failed", true, 503);
    });
    await expect(withSocialTokenRefresh({ ...db.row }, refresh)).rejects.toMatchObject({
      retryable: true,
    });
    db.fail = true;
    await expect(withSocialTokenRefresh({ ...db.row }, refresh)).rejects.toMatchObject({
      code: "refresh_unavailable",
    });
  });
  it("refreshes Threads before expiry even without a separate refresh token", async () => {
    Object.assign(db.row, {
      provider: "threads",
      refresh_token: null,
      token_expires_at: new Date(Date.now() + 86400_000).toISOString(),
    });
    const refresh = vi.fn(async () => refreshed());
    await withSocialTokenRefresh({ ...db.row }, refresh);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it("keeps still-valid LinkedIn access until actual expiry when no refresh token was issued", async () => {
    Object.assign(db.row, {
      provider: "linkedin",
      refresh_token: null,
      token_expires_at: new Date(Date.now() + 120_000).toISOString(),
    });
    const refresh = vi.fn();
    expect(await withSocialTokenRefresh({ ...db.row }, refresh)).toBe("old");
    expect(refresh).not.toHaveBeenCalled();
  });
  it("requires reconnection only for revoked/expired authorization", () => {
    for (const code of ["invalid_grant", "reconnect_required"])
      expect(needsSocialReconnect(new ProviderError("rejected", code, false, 400))).toBe(true);
    for (const code of [
      "429",
      "503",
      "invalid_client",
      "refresh_in_progress",
      "refresh_save_failed",
    ])
      expect(needsSocialReconnect(new ProviderError("temporary", code, true, 503))).toBe(false);
  });
});
