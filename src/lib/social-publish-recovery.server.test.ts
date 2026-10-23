/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  target: {} as any,
  changes: [] as any[],
  attempts: [] as any[],
  email: vi.fn(),
  membership: { auth_user_id: "owner" } as { auth_user_id: string } | null,
  membershipError: null as { message: string } | null,
  authLookups: [] as string[],
  filters: [] as unknown[][],
}));
vi.mock("./plan.server", () => ({ getPlan: async () => "creator_plus" }));
vi.mock("./plans", () => ({ planHasEntitlement: () => true }));
vi.mock("./secret-crypto.server", () => ({ decryptServerSecret: async () => "token" }));
vi.mock("./social-token-refresh.server", () => ({ withSocialTokenRefresh: async () => "token" }));
vi.mock("./email.server", () => ({ enqueueEmail: state.email }));
vi.mock("./scheduled-instagram-auto-dm.server", () => ({
  activateScheduledInstagramAutoDm: async () => {},
  reconcileScheduledInstagramAutoDms: async () => {},
}));
vi.mock("./scheduled-post-auto-dm.server", () => ({
  activateScheduledPostAutoDm: async () => {},
  reconcileScheduledPostAutoDms: async () => {},
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    auth: {
      admin: {
        getUserById: async (id: string) => {
          state.authLookups.push(id);
          return { data: { user: { email: "owner@example.com" } } };
        },
      },
    },
    from(table: string) {
      let values: any;
      const chain: any = {
        select: () => chain,
        eq: (field: string, value: unknown) => {
          state.filters.push([table, field, value]);
          return chain;
        },
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        update: (v: any) => {
          values = v;
          state.changes.push({ table, ...v });
          return chain;
        },
        insert: (v: any) => {
          state.attempts.push(v);
          return chain;
        },
        maybeSingle: async () => ({
          data:
            table === "workspace_memberships"
              ? state.membership
              : values
                ? { id: "target" }
                : { ...state.target },
          error: table === "workspace_memberships" ? state.membershipError : null,
        }),
        then: (resolve: any) =>
          Promise.resolve({ data: values ? [] : [{ status: "failed" }], error: null }).then(
            resolve,
          ),
      };
      return chain;
    },
  },
}));
import { processSocialPublishMessage } from "./social-publisher.server";
const message = { kind: "social_publish" as const, targetId: "target", idempotencyKey: "cycle-1" };
beforeEach(() => {
  state.changes = [];
  state.attempts = [];
  state.membership = { auth_user_id: "owner" };
  state.membershipError = null;
  state.authLookups = [];
  state.filters = [];
  state.email.mockReset().mockResolvedValue({ id: "email" });
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-22T13:04:00Z"));
  state.target = {
    id: "target",
    post_id: "post",
    idempotency_key: "cycle-1",
    status: "queued",
    provider: "instagram",
    attempt_count: 1,
    created_at: "2026-10-20T20:11:52Z",
    retry_started_at: null,
    processing_started_at: "2026-10-22T13:02:20Z",
    remote_post_id: "container",
    post: {
      user_id: "owner",
      title: "A useful post",
      status: "publishing",
      scheduled_at: "2026-10-22T13:00:00Z",
    },
    connection: {
      user_id: "owner",
      provider: "instagram",
      provider_user_id: "account",
      access_token: "encrypted",
      status: "active",
    },
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("social publishing recovery", () => {
  it("delivers secondary-workspace failures to the active owner's auth account and preserves workspace context", async () => {
    state.target.post.user_id = "secondary-workspace";
    state.target.connection.user_id = "secondary-workspace";
    state.target.processing_started_at = "2026-10-21T12:00:00Z";
    state.membership = { auth_user_id: "owner-auth-account" };
    await processSocialPublishMessage(message);
    expect(state.authLookups).toEqual(["owner-auth-account"]);
    expect(state.filters).toEqual(
      expect.arrayContaining([
        ["workspace_memberships", "workspace_id", "secondary-workspace"],
        ["workspace_memberships", "role", "owner"],
        ["workspace_memberships", "status", "active"],
      ]),
    );
    expect(state.email).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientEmail: "owner@example.com",
        userId: "owner-auth-account",
        eventKey: "social-publish-failed:target:cycle-1",
        payload: expect.objectContaining({ workspaceId: "secondary-workspace" }),
      }),
    );
  });
  it.each([null, { message: "membership unavailable" }])(
    "does not guess a recipient when active ownership is missing or unavailable",
    async (error) => {
      state.target.post.user_id = "secondary-workspace";
      state.target.processing_started_at = "2026-10-21T12:00:00Z";
      state.membership = null;
      state.membershipError = error;
      await processSocialPublishMessage(message);
      expect(state.authLookups).toEqual([]);
      expect(state.email).not.toHaveBeenCalled();
      expect(state.changes).toContainEqual(
        expect.objectContaining({ failure_notification_pending: true }),
      );
      expect(state.changes.some((v) => v.failure_notification_pending === false)).toBe(false);
    },
  );

  it("does not expire a newly uploaded container just because its draft is two days old", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ status_code: "IN_PROGRESS" }));
    vi.stubGlobal("fetch", fetcher);
    await processSocialPublishMessage(message);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(state.changes).toContainEqual(
      expect.objectContaining({
        status: "processing",
        processing_started_at: "2026-10-22T13:02:20Z",
      }),
    );
    expect(state.changes.some((v) => v.last_error_code === "processing_timeout")).toBe(false);
  });
  it("records a real processing timeout and reliably queues an owner notification", async () => {
    state.target.processing_started_at = "2026-10-21T12:00:00Z";
    vi.stubGlobal("fetch", vi.fn());
    await processSocialPublishMessage(message);
    expect(fetch).not.toHaveBeenCalled();
    expect(state.changes).toContainEqual(
      expect.objectContaining({
        status: "failed",
        failure_notification_pending: true,
        last_error_code: "processing_timeout",
      }),
    );
    expect(state.email).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: "social-publish-failed:target:cycle-1",
        recipientEmail: "owner@example.com",
        userId: "owner",
        eventType: "social_publish_failed",
        payload: expect.objectContaining({ postTitle: "A useful post" }),
      }),
    );
    expect(state.attempts).toContainEqual(
      expect.objectContaining({ outcome: "failed", error_code: "processing_timeout" }),
    );
  });
  it("retains notification work if email enqueue fails without retrying the paid publish", async () => {
    state.target.processing_started_at = "2026-10-21T12:00:00Z";
    state.email.mockRejectedValue(new Error("outbox unavailable"));
    await expect(processSocialPublishMessage(message)).resolves.toBeUndefined();
    expect(state.changes.some((v) => v.failure_notification_pending === false)).toBe(false);
  });
  it("does not publish an already-published Meta container a second time", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ status_code: "PUBLISHED" })));
    await processSocialPublishMessage(message);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(state.changes).toContainEqual(expect.objectContaining({ status: "outcome_unknown" }));
  });
});
