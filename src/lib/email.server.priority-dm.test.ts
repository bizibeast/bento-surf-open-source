import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  getUserById: vi.fn(),
  issueMagicLink: vi.fn(),
  outboxUpsert: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: mocks.from,
    auth: { admin: { getUserById: mocks.getUserById } },
  },
}));
vi.mock("./customer-library-magic-link.server", () => ({
  issueCustomerLibraryMagicLinkForEmail: mocks.issueMagicLink,
}));

import {
  enqueuePriorityDmMessageToBuyerEmail,
  enqueuePriorityDmMessageToCreatorEmail,
} from "./email.server";

const requestId = "11111111-1111-4111-8111-111111111111";

function rowQuery(data: unknown) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error: null }),
    single: vi.fn().mockResolvedValue({ data, error: null }),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  return query;
}

describe("legacy Priority DM notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserById.mockResolvedValue({ data: { user: { email: "creator@example.com" } } });
    mocks.issueMagicLink.mockResolvedValue("https://app.bento.surf/library/verify?token=secret");
    mocks.outboxUpsert.mockReturnValue({
      select: () => ({ maybeSingle: async () => ({ data: { id: "outbox-1" }, error: null }) }),
    });
  });

  it.each([
    ["buyer", enqueuePriorityDmMessageToCreatorEmail],
    ["creator", enqueuePriorityDmMessageToBuyerEmail],
  ] as const)("does not enqueue a backfilled %s message", async (sender, enqueue) => {
    mocks.from.mockImplementation((table: string) => {
      if (table === "commerce_priority_dm_messages")
        return rowQuery({
          id: "message-1",
          request_id: requestId,
          sender,
          body: "Legacy message",
          notification_eligible: false,
        });
      if (table === "commerce_priority_dm_requests")
        return rowQuery({
          id: requestId,
          product_id: "product-1",
          creator_id: "creator-1",
          buyer_email: "buyer@example.com",
          buyer_name: "Buyer",
        });
      if (table === "commerce_products") return rowQuery({ title: "Priority review" });
      if (table === "profiles") return rowQuery({ username: "creator", display_name: "Creator" });
      if (table === "email_outbox") return { upsert: mocks.outboxUpsert };
      throw new Error(`Unexpected table ${table}`);
    });

    await expect(enqueue({ requestId, messageId: "message-1" })).resolves.toBeNull();

    expect(mocks.outboxUpsert).not.toHaveBeenCalled();
    expect(mocks.issueMagicLink).not.toHaveBeenCalled();
    expect(mocks.getUserById).not.toHaveBeenCalled();
    expect(mocks.from.mock.calls.map(([table]) => table)).not.toEqual(
      expect.arrayContaining(["commerce_products", "profiles", "email_outbox"]),
    );
  });
});
