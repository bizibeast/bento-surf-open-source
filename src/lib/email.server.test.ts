import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueEmail: vi.fn(),
  getUserById: vi.fn(),
  membershipMaybeSingle: vi.fn(),
  profileMaybeSingle: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    auth: {
      admin: {
        getUserById: mocks.getUserById,
      },
    },
    from: (table: string) => {
      const query: Record<string, unknown> = {};
      query.select = () => query;
      query.eq = () => query;
      query.maybeSingle =
        table === "workspace_memberships" ? mocks.membershipMaybeSingle : mocks.profileMaybeSingle;
      return query;
    },
  },
}));

import { enqueueContentDraftsReadyEmail } from "./email.server";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUserById.mockResolvedValue({ data: { user: { email: "creator@example.com" } } });
  mocks.membershipMaybeSingle.mockResolvedValue({
    data: { auth_user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    error: null,
  });
  mocks.profileMaybeSingle.mockResolvedValue({
    data: { display_name: "Creator", username: "creator" },
    error: null,
  });
});

it("uses the routine run as the drafts-ready email idempotency key", async () => {
  const input = {
    userId: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222",
    draftCount: 5,
    platforms: ["LinkedIn", "Instagram"],
  };
  await enqueueContentDraftsReadyEmail(input, mocks.enqueueEmail);
  expect(mocks.enqueueEmail).toHaveBeenCalledWith(
    expect.objectContaining({
      eventKey: `content-drafts-ready:${input.runId}`,
      eventType: "content_drafts_ready",
      recipientEmail: "creator@example.com",
      userId: input.userId,
      immediate: true,
    }),
  );
  expect(mocks.getUserById).toHaveBeenCalledWith("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
});

it("does not enqueue an empty ready email", async () => {
  await enqueueContentDraftsReadyEmail(
    { userId: "owner", runId: "run", draftCount: 0, platforms: [] },
    mocks.enqueueEmail,
  );
  expect(mocks.enqueueEmail).not.toHaveBeenCalled();
});
