import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FACEBOOK_AUTO_DM_REQUIRED_SCOPES,
  FACEBOOK_AUTO_DM_WEBHOOK_FIELDS,
} from "./facebook-auto-dm";
import { TWITTER_AUTO_DM_REQUIRED_SCOPES, TWITTER_AUTO_DM_WEBHOOK_FIELDS } from "./twitter-auto-dm";
import { scheduledPostAutoDmDraft, scheduledPostAutoDmSettings } from "./scheduled-post-auto-dm";

const mocks = vi.hoisted(() => ({
  existing: null as unknown,
  connection: null as unknown,
  insert: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  entitlement: vi.fn(),
  requireEntitlement: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("./plan.server", () => ({
  hasPlanEntitlement: mocks.entitlement,
  requirePlanEntitlement: mocks.requireEntitlement,
}));
import {
  activateScheduledPostAutoDm,
  reconcileScheduledPostAutoDms,
  validateScheduledPostAutoDms,
} from "./scheduled-post-auto-dm.server";

function ready(provider: "twitter" | "facebook") {
  return {
    provider,
    status: "active",
    connection_health: "healthy",
    reauth_required: false,
    scopes:
      provider === "twitter"
        ? [...TWITTER_AUTO_DM_REQUIRED_SCOPES]
        : [...FACEBOOK_AUTO_DM_REQUIRED_SCOPES],
    webhook_fields:
      provider === "twitter"
        ? [...TWITTER_AUTO_DM_WEBHOOK_FIELDS]
        : [...FACEBOOK_AUTO_DM_WEBHOOK_FIELDS],
    token_expires_at: new Date(Date.now() + 86400000).toISOString(),
    last_verified_at: new Date().toISOString(),
  };
}
function target(provider: "twitter" | "facebook") {
  const draft = {
    ...scheduledPostAutoDmDraft(provider),
    enabled: true,
    publicReplyEnabled: true,
    emailCaptureEnabled: true,
  };
  return {
    provider,
    status: "published",
    remote_post_id: "remote-123",
    post_id: "post-1",
    connection_id: "connection-1",
    post: { user_id: "owner-1" },
    provider_settings: { scheduledAutoDm: scheduledPostAutoDmSettings(provider, draft) },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.existing = null;
  mocks.connection = ready("twitter");
  mocks.entitlement.mockResolvedValue(true);
  mocks.requireEntitlement.mockResolvedValue(undefined);
  mocks.insert.mockResolvedValue({ error: null });
  mocks.rpc.mockResolvedValue({ data: [], error: null });
  mocks.from.mockImplementation((table) => {
    const query: Record<string, unknown> = {
      insert: mocks.insert,
      maybeSingle: async () => ({
        data: table === "social_connections" ? mocks.connection : mocks.existing,
        error: null,
      }),
    };
    query.select = () => query;
    query.eq = () => query;
    return query;
  });
});

describe.each(["twitter", "facebook"] as const)("scheduled %s Auto DM", (provider) => {
  it("waits for confirmed publication and binds the rule to the resulting post", async () => {
    mocks.connection = ready(provider);
    await activateScheduledPostAutoDm({ ...target(provider), status: "processing" });
    await activateScheduledPostAutoDm({ ...target(provider), remote_post_id: null });
    expect(mocks.insert).not.toHaveBeenCalled();
    await activateScheduledPostAutoDm(target(provider));
    expect(mocks.from).toHaveBeenCalledWith(`${provider}_dm_automations`);
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduled_post_id: "post-1",
        user_id: "owner-1",
        connection_id: "connection-1",
        enabled: true,
        ...(provider === "twitter"
          ? { source_post_id: "remote-123" }
          : {
              media_scope: "specific",
              media_ids: ["remote-123"],
              public_reply_messages: [
                "Sent it to your DMs ✨",
                "Check your messages 💌",
                "On its way 🙌",
              ],
              email_capture_enabled: true,
              email_marketing_consent_enabled: false,
            }),
      }),
    );
  });
  it("preserves existing edits/pauses and waits for permission repair", async () => {
    mocks.connection = ready(provider);
    mocks.existing = { id: "paused-rule" };
    await activateScheduledPostAutoDm(target(provider));
    expect(mocks.insert).not.toHaveBeenCalled();
    mocks.existing = null;
    mocks.connection = { ...ready(provider), scopes: [] };
    await activateScheduledPostAutoDm(target(provider));
    expect(mocks.insert).not.toHaveBeenCalled();
    mocks.connection = ready(provider);
    mocks.entitlement.mockResolvedValue(false);
    await activateScheduledPostAutoDm(target(provider));
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("handles concurrent activation without creating another rule", async () => {
    mocks.connection = ready(provider);
    mocks.insert.mockResolvedValue({ error: { code: "23505" } });
    await expect(activateScheduledPostAutoDm(target(provider))).resolves.toBeUndefined();
    mocks.insert.mockResolvedValue({ error: { code: "database_unavailable" } });
    await expect(activateScheduledPostAutoDm(target(provider))).rejects.toEqual({
      code: "database_unavailable",
    });
  });
  it("rejects missing destinations and permissions before scheduling", async () => {
    const settings = { [provider]: target(provider).provider_settings };
    await expect(validateScheduledPostAutoDms("owner-1", settings, [])).rejects.toThrow(/Select/);
    await expect(
      validateScheduledPostAutoDms("owner-1", settings, [{ ...ready(provider), scopes: [] }]),
    ).rejects.toThrow(/Reconnect/);
    await expect(
      validateScheduledPostAutoDms("owner-1", settings, [ready(provider)]),
    ).resolves.toBeUndefined();
    expect(mocks.requireEntitlement).toHaveBeenCalledWith(
      "owner-1",
      "advancedAutoDM",
      expect.any(String),
    );
  });
});

it("bounds reconciliation and continues after a failed activation", async () => {
  mocks.rpc.mockResolvedValue({ data: [target("twitter"), target("twitter")], error: null });
  mocks.insert.mockRejectedValueOnce(new Error("temporary outage"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await reconcileScheduledPostAutoDms();
  expect(mocks.rpc).toHaveBeenCalledWith("pending_scheduled_post_auto_dms", { p_limit: 50 });
  expect(mocks.insert).toHaveBeenCalledTimes(2);
  log.mockRestore();
});
