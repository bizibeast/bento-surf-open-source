import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existing: null as { id: string } | null,
  connection: null as Record<string, unknown> | null,
  insert: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: vi.fn((table: string) => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({
              data: table === "social_connections" ? mocks.connection : mocks.existing,
              error: null,
            })),
          })),
        })),
      })),
      insert: mocks.insert,
    })),
  },
}));

import { activateScheduledInstagramAutoDm } from "./scheduled-instagram-auto-dm.server";

const target = {
  provider: "instagram",
  status: "published",
  post_id: "post-1",
  connection_id: "connection-1",
  remote_post_id: "instagram-media-1",
  published_at: "2026-10-09T10:00:00.000Z",
  post: { user_id: "owner-1" },
  provider_settings: {
    scheduledAutoDm: {
      triggerType: "comment_keyword",
      keyword: "GUIDE",
      openingMessage: "Tap Send it for the guide",
      replyMessage: "Here is your guide",
      publicReplyEnabled: true,
      publicReplyMessages: ["Check your DMs"],
      emailCaptureEnabled: true,
      emailPromptMessage: "Where should I email the guide?",
      followGateEnabled: true,
      followFailAction: "withhold",
      replyButtonLabel: "Get guide",
      replyButtonUrl: "https://bento.surf/guide",
    },
  },
};

describe("scheduled Instagram auto DM activation", () => {
  beforeEach(() => {
    mocks.existing = null;
    mocks.connection = {
      status: "active",
      connection_health: "healthy",
      reauth_required: false,
      scopes: [
        "instagram_business_basic",
        "instagram_business_manage_comments",
        "instagram_business_manage_messages",
      ],
      webhook_fields: ["comments", "live_comments", "messages", "messaging_postbacks"],
      token_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      last_verified_at: new Date().toISOString(),
    };
    mocks.insert.mockReset().mockResolvedValue({ error: null });
  });

  it("waits for confirmed publication and scopes the automation to its media", async () => {
    await activateScheduledInstagramAutoDm({ ...target, status: "processing" });
    expect(mocks.insert).not.toHaveBeenCalled();

    await activateScheduledInstagramAutoDm(target);
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduled_post_id: "post-1",
        connection_id: "connection-1",
        media_scope: "specific",
        media_ids: ["instagram-media-1"],
        enabled: true,
        public_reply_enabled: true,
        public_reply_messages: ["Check your DMs"],
        email_capture_enabled: true,
        email_prompt_message: "Where should I email the guide?",
        follow_gate_enabled: true,
        follow_fail_action: "withhold",
        reply_button_label: "Get guide",
        reply_button_url: "https://bento.surf/guide",
      }),
    );
  });

  it("preserves an existing automation, including a user pause", async () => {
    mocks.existing = { id: "automation-1" };
    await activateScheduledInstagramAutoDm(target);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("waits for Instagram connection repair before activating", async () => {
    mocks.connection = { ...mocks.connection, connection_health: "unhealthy" };
    await activateScheduledInstagramAutoDm(target);
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
