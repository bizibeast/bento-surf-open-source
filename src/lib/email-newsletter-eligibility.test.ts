import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: mocks.from,
    rpc: mocks.rpc,
    auth: { admin: { getUserById: vi.fn() } },
  },
}));

vi.mock("./customer-library-magic-link.server", () => ({
  issueCustomerLibraryMagicLinkForEmail: vi.fn(),
}));

import { marketingAllowedForOutbox, processEmailOutbox } from "./email.server";

function query(data: unknown) {
  const result = { data, error: null };
  const builder: Record<string, unknown> = {
    select: vi.fn(() => builder),
    update: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn().mockResolvedValue(result),
    then: (resolve: (value: unknown) => void) => resolve(result),
  };
  return builder;
}

const row = {
  id: "11111111-1111-4111-8111-111111111111",
  event_key:
    "audience-campaign:33333333-3333-4333-8333-333333333333:55555555-5555-4555-8555-555555555555",
  event_type: "creator_campaign",
  category: "marketing",
  recipient_email: "reader@example.com",
  recipient_name: "Reader",
  user_id: null,
  attempts: 1,
  payload: {
    audienceContactId: "55555555-5555-4555-8555-555555555555",
    creatorId: "44444444-4444-4444-8444-444444444444",
    creatorName: "Ari",
    creatorUrl: "https://bento.surf/@ari",
    subject: "Studio Notes",
    previewText: "Issue preview",
    body: "Issue body",
    newsletterPublicationId: "77777777-7777-4777-8777-777777777777",
    newsletterVisibility: "paid",
    newsletterPaidProductId: "66666666-6666-4666-8666-666666666666",
  },
};

const lifecycleRow = {
  ...row,
  event_key: "lifecycle:weekly-digest:user-1:2026-08-31",
  event_type: "weekly_digest",
  user_id: "99999999-9999-4999-8999-999999999999",
  payload: {},
};

describe("newsletter send-time eligibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.EMAIL_DELIVERY_MODE = "production";
    process.env.RESEND_API_KEY = "resend-key";
    process.env.RESEND_FROM_EMAIL = "Bento <hello@example.com>";
    process.env.EMAIL_SIGNING_SECRET = "a-secure-email-signing-secret-123456";
    vi.stubGlobal("fetch", mocks.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(process.env, "EMAIL_DELIVERY_MODE");
    Reflect.deleteProperty(process.env, "RESEND_API_KEY");
    Reflect.deleteProperty(process.env, "RESEND_FROM_EMAIL");
    Reflect.deleteProperty(process.env, "EMAIL_SIGNING_SECRET");
  });

  it("keeps early global suppression for non-campaign marketing email", async () => {
    mocks.from.mockImplementation((table: string) => {
      if (table === "email_suppressions") return query({ email: "reader@example.com" });
      throw new Error(`Unexpected table ${table}`);
    });

    await expect(marketingAllowedForOutbox(lifecycleRow as never)).resolves.toBe(false);
  });

  it("uses only the final campaign authorization RPC before provider POST", async () => {
    const order: string[] = [];
    const tables: string[] = [];
    mocks.from.mockImplementation((table: string) => {
      tables.push(table);
      if (table === "email_outbox") return query(null);
      throw new Error(`Unexpected table ${table}`);
    });
    mocks.rpc.mockImplementation((name: string, input: unknown) => {
      if (name === "claim_email_outbox") return Promise.resolve({ data: [row], error: null });
      if (name === "authorize_audience_campaign_delivery") {
        order.push("authorize");
        expect(input).toEqual({ p_outbox_id: row.id });
        expect(tables).toEqual([]);
        return Promise.resolve({ data: true, error: null });
      }
      if (name === "update_audience_campaign_recipient_status") {
        return Promise.resolve({ data: 1, error: null });
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
    mocks.fetch.mockImplementation(() => {
      order.push("provider-post");
      return Promise.resolve(
        new Response(JSON.stringify({ id: "resend-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    await expect(processEmailOutbox(1)).resolves.toEqual({ claimed: 1, sent: 1, configured: true });
    expect(order).toEqual(["authorize", "provider-post"]);
    expect(tables).toEqual(["email_outbox"]);
  });

  it("does not POST when final campaign authorization finds global suppression", async () => {
    mocks.from.mockImplementation((table: string) => {
      throw new Error(`Unexpected early table read ${table}`);
    });
    mocks.rpc.mockImplementation((name: string) => {
      if (name === "claim_email_outbox") return Promise.resolve({ data: [row], error: null });
      if (name === "authorize_audience_campaign_delivery") {
        return Promise.resolve({ data: false, error: null });
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    await expect(processEmailOutbox(1)).resolves.toEqual({ claimed: 1, sent: 0, configured: true });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
