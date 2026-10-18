/* eslint-disable @typescript-eslint/no-explicit-any -- Simulated provider responses. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  token: vi.fn(),
  reserve: vi.fn(),
  changes: [] as any[],
  filters: [] as any[],
  claimed: true,
}));
vi.mock("./provider-budget.server", () => ({
  reserveProviderUsage: state.reserve,
  reserveXRead: state.reserve,
  xBackgroundReadsEnabled: () => false,
  ProviderBudgetError: class extends Error {},
}));
vi.mock("./social-publisher.server", () => ({
  accessTokenForConnection: state.token,
  ProviderError: class extends Error {},
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      const chain: any = {
        update: (value: any) => {
          state.changes.push(value);
          return chain;
        },
        eq: (...args: any[]) => {
          state.filters.push(args);
          return chain;
        },
        or: (...args: any[]) => {
          state.filters.push(args);
          return chain;
        },
        select: () => chain,
        maybeSingle: async () => ({
          data: state.claimed ? { id: "connection" } : null,
          error: null,
        }),
      };
      return chain;
    },
  },
}));
import {
  verifyTwitterAutoDmConnection,
  verifyTwitterWebhookRegistration,
  refreshTwitterAutoDmHealth,
  twitterAutoDmErrorNeedsReauth,
} from "./twitter-auto-dm.server";
const connection = () => ({
  id: "connection",
  user_id: "owner",
  provider_user_id: "123",
  access_token: "encrypted",
  scopes: ["dm.read", "dm.write", "tweet.read", "users.read", "offline.access"],
});
const validWebhook = {
  data: [{ id: "987", url: "http://localhost:8080/api/webhooks/twitter", valid: true }],
};
function responses(...items: Array<{ status?: number; data: any }>) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => {
    void _url;
    void _init;
    const item = items.shift();
    if (!item) throw new Error("Unexpected network call");
    return Response.json(item.data, { status: item.status || 200 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
beforeEach(() => {
  vi.stubEnv("APP_ENV", "production");
  vi.stubEnv("VITE_APP_URL", "http://localhost:8080");
  vi.stubEnv("X_APP_BEARER_TOKEN", "app-bearer");
  vi.stubEnv("X_CONSUMER_KEY", "");
  vi.stubEnv("X_CONSUMER_SECRET", "");
  vi.stubEnv("X_ACCOUNT_ACTIVITY_ENABLED", "false");
  state.token.mockReset().mockResolvedValue("user-token");
  state.reserve.mockReset().mockResolvedValue(undefined);
  state.changes = [];
  state.filters = [];
  state.claimed = true;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("X webhook verification", () => {
  it("prevents staging from consuming a production app's webhook allowance", async () => {
    vi.stubEnv("APP_ENV", "staging");
    const fetch = responses();
    await expect(verifyTwitterWebhookRegistration()).rejects.toMatchObject({
      code: "webhook_staging_isolation",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("requires an app credential and never treats missing configuration as success", async () => {
    vi.stubEnv("X_APP_BEARER_TOKEN", "");
    const fetch = responses();
    await expect(verifyTwitterAutoDmConnection(connection())).rejects.toMatchObject({
      code: "webhook_not_configured",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses OAuth 1 consumer keys and the correct app-token endpoint when needed", async () => {
    vi.stubEnv("X_APP_BEARER_TOKEN", "");
    vi.stubEnv("X_CONSUMER_KEY", "key");
    vi.stubEnv("X_CONSUMER_SECRET", "secret");
    const fetch = responses(
      { data: { token_type: "bearer", access_token: "app-token" } },
      { data: validWebhook },
    );
    await expect(verifyTwitterWebhookRegistration()).resolves.toMatchObject({ id: "987" });
    expect(fetch.mock.calls[0]).toEqual([
      "https://api.x.com/oauth2/token",
      expect.objectContaining({
        method: "POST",
        body: "grant_type=client_credentials",
        headers: expect.objectContaining({ Authorization: `Basic ${btoa("key:secret")}` }),
      }),
    ]);
  });
  it("confirms an existing subscription without any paid identity or history probes", async () => {
    const fetch = responses({ data: validWebhook }, { data: { data: { subscribed: true } } });
    await expect(verifyTwitterAutoDmConnection(connection())).resolves.toMatchObject({
      fields: ["direct_messages", "mentions"],
    });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      "https://api.x.com/2/webhooks",
      "https://api.x.com/2/account_activity/webhooks/987/subscriptions/all",
    ]);
  });
  it("creates and CRC-validates a missing callback, requiring an ID and valid status", async () => {
    const fetch = responses(
      { data: { data: [] } },
      { data: { data: { id: "987", valid: false } } },
      { data: { data: { valid: true } } },
    );
    await expect(verifyTwitterWebhookRegistration()).resolves.toMatchObject({ id: "987" });
    expect(fetch.mock.calls[2]).toEqual([
      "https://api.x.com/2/webhooks/987",
      expect.objectContaining({ method: "PUT" }),
    ]);
  });
  it("revalidates an existing invalid callback instead of trusting its ID", async () => {
    responses(
      { data: { data: [{ ...validWebhook.data[0], valid: false }] } },
      { data: { data: { valid: false } } },
    );
    await expect(verifyTwitterWebhookRegistration()).rejects.toMatchObject({
      code: "webhook_crc_failed",
    });
  });
  it.each([401, 402, 403, 429, 503])(
    "surfaces HTTP %i without false account disconnection or more requests",
    async (status) => {
      const fetch = responses({ status, data: { title: "Provider rejected request" } });
      const error = await verifyTwitterAutoDmConnection(connection()).catch((e) => e);
      expect(error.code).toBe(`webhook_${status}`);
      expect(error.message).toContain(`HTTP ${status}`);
      expect(twitterAutoDmErrorNeedsReauth(error)).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each([{ data: {} }, { data: { errors: [{ message: "failure" }] } }])(
    "rejects incomplete or failed creation responses",
    async (response) => {
      responses({ data: { data: [] } }, response);
      await expect(verifyTwitterWebhookRegistration()).rejects.toBeInstanceOf(Error);
    },
  );
  it("does not open a billable event feed when only verification was requested", async () => {
    const fetch = responses({ data: validWebhook }, { data: { data: { subscribed: false } } });
    await expect(verifyTwitterAutoDmConnection(connection())).rejects.toMatchObject({
      code: "webhook_events_disabled",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("requires explicit subscription confirmation after enabling account delivery", async () => {
    vi.stubEnv("X_ACCOUNT_ACTIVITY_ENABLED", "true");
    responses({ data: validWebhook }, { data: { data: { subscribed: false } } }, { data: {} });
    await expect(verifyTwitterAutoDmConnection(connection())).rejects.toMatchObject({
      code: "webhook_subscription_unconfirmed",
    });
  });
  it("repairs a missing subscription with the user token when billing is configured", async () => {
    vi.stubEnv("X_ACCOUNT_ACTIVITY_ENABLED", "true");
    const fetch = responses(
      { data: validWebhook },
      { status: 404, data: {} },
      { data: { data: { subscribed: true } } },
    );
    await expect(verifyTwitterAutoDmConnection(connection())).resolves.toMatchObject({
      fields: ["direct_messages", "mentions"],
    });
    expect(fetch.mock.calls[2]).toEqual([
      expect.stringContaining("/subscriptions/all"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer user-token" }),
      }),
    ]);
  });
  it("renews user authorization once on 401 before reporting failure", async () => {
    responses(
      { data: validWebhook },
      { status: 401, data: {} },
      { data: { data: { subscribed: true } } },
    );
    await verifyTwitterAutoDmConnection(connection());
    expect(state.token).toHaveBeenLastCalledWith(expect.anything(), { forceRefresh: true });
    expect(state.token).toHaveBeenCalledTimes(2);
  });
  it("rejects a malformed subscription response instead of creating another", async () => {
    vi.stubEnv("X_ACCOUNT_ACTIVITY_ENABLED", "true");
    const fetch = responses({ data: validWebhook }, { data: {} });
    await expect(verifyTwitterAutoDmConnection(connection())).rejects.toMatchObject({
      code: "webhook_invalid_response",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("saves actionable errors and retains connected authorization", async () => {
    responses({ status: 403, data: {} });
    await expect(refreshTwitterAutoDmHealth(connection())).rejects.toMatchObject({
      code: "webhook_403",
    });
    expect(state.changes.at(-1)).toMatchObject({
      connection_health: "action_required",
      webhook_fields: [],
      last_verified_at: null,
      last_error: expect.stringContaining("HTTP 403"),
    });
    expect(state.changes.at(-1)).not.toHaveProperty("reauth_required");
    expect(state.filters).toContainEqual(["access_token", "encrypted"]);
    expect(state.filters.some(([key]) => key === "twitter_webhook_check_lease_until")).toBe(true);
  });
  it("prevents concurrent verification network calls when another worker holds the lease", async () => {
    state.claimed = false;
    const fetch = responses();
    await expect(refreshTwitterAutoDmHealth(connection())).rejects.toMatchObject({
      code: "webhook_check_busy",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
