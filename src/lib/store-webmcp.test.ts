// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setWebinarRegistrationAttendance } from "./commerce.functions";
import { createStoreWebMcpTools, type StoreWebMcpState } from "./store-webmcp";

vi.mock("./commerce.functions", () => ({
  setWebinarRegistrationAttendance: vi.fn(),
}));

const productId = "11111111-1111-4111-8111-111111111111";
const registrationId = "22222222-2222-4222-8222-222222222222";
const contactId = "44444444-4444-4444-8444-444444444444";
const listId = "55555555-5555-4555-8555-555555555555";
const eventId = "66666666-6666-4666-8666-666666666666";
const signal = new AbortController().signal;

const state = {
  products: [{ id: productId, title: "Live workshop" }],
  webinarRegistrations: [
    {
      id: registrationId,
      access_grant_id: "private-access-grant",
      order_id: "private-order",
      product_id: productId,
      creator_id: "private-creator",
      buyer_email: "attendee@example.com",
      buyer_name: "Attendee",
      starts_at: "2026-09-01T10:00:00.000Z",
      ends_at: "2026-09-01T11:00:00.000Z",
      timezone: "Asia/Kolkata",
      join_url: "https://meet.example/private-room",
      replay_url: "https://storage.example/private-replay",
      status: "registered",
      reminder_24h_sent_at: null,
      reminder_1h_sent_at: null,
      replay_ready_notified_at: null,
      attended_at: null,
      created_at: "2026-08-30T00:00:00.000Z",
      updated_at: "2026-08-30T00:00:00.000Z",
    },
  ],
  audienceContacts: [
    {
      id: contactId,
      creator_id: "private-creator",
      customer_id: "private-customer",
      email: "audience@example.com",
      name: "Audience member",
      marketing_consent: true,
      marketing_status: "subscribed",
      marketing_consented_at: "2026-08-30T00:00:00.000Z",
      marketing_unsubscribed_at: null,
      first_source: "lead_form",
      last_source: "order",
      first_seen_at: "2026-08-29T00:00:00.000Z",
      last_seen_at: "2026-08-30T00:00:00.000Z",
      created_at: "2026-08-29T00:00:00.000Z",
      updated_at: "2026-08-30T00:00:00.000Z",
    },
  ],
  audienceLists: [
    {
      id: listId,
      creator_id: "private-creator",
      name: "Customers",
      description: "People who bought",
      created_at: "2026-08-30T00:00:00.000Z",
      updated_at: "2026-08-30T00:00:00.000Z",
    },
  ],
  audienceListMembers: [{ list_id: listId, contact_id: contactId }],
  audienceEvents: [
    {
      id: eventId,
      creator_id: "private-creator",
      contact_id: contactId,
      event_type: "order_paid",
      source_type: "store",
      source_id: "private-provider-source",
      product_id: productId,
      order_id: "private-event-order",
      booking_id: "private-booking",
      amount: 2500,
      currency: "usd",
      metadata: { token: "private-event-token" },
      occurred_at: "2026-08-30T02:00:00.000Z",
    },
  ],
} satisfies StoreWebMcpState;

function tool(name: string, refresh = vi.fn()) {
  return createStoreWebMcpTools({ data: state, refresh }).find((item) => item.name === name)!;
}

describe("Store WebMCP tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns useful Store activity while excluding emails, access URLs, storage data, and private IDs", async () => {
    const webinar = await tool("bento_get_webinar_registrations").execute({}, { signal });
    const audience = await tool("bento_get_store_audience_activity").execute({}, { signal });
    const result = JSON.stringify({ webinar, audience });

    expect(webinar).toMatchObject({
      structuredContent: {
        registrations: [
          {
            id: registrationId,
            productTitle: "Live workshop",
            buyerName: "Attendee",
            status: "registered",
          },
        ],
      },
    });
    expect(audience).toMatchObject({
      structuredContent: {
        contacts: [{ id: contactId, name: "Audience member", marketingStatus: "subscribed" }],
        memberships: [{ listId, contactId, listName: "Customers" }],
        events: [{ id: eventId, contactId, eventType: "order_paid", amount: 2500 }],
      },
    });
    expect(result).not.toMatch(
      /attendee@example|audience@example|private-|meet\.example|storage\.example/,
    );
    expect(
      createStoreWebMcpTools({ data: state, refresh: vi.fn() }).map((item) => item.name),
    ).not.toEqual(
      expect.arrayContaining(["bento_get_priority_dm_requests", "bento_reply_to_priority_dm"]),
    );
  });

  it("rejects out-of-contract read input", () => {
    expect(() =>
      tool("bento_get_store_audience_activity").execute(
        { limit: 101, unexpected: true },
        { signal },
      ),
    ).toThrow();
  });

  it("fails closed before the Store mutation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);

    await expect(
      tool("bento_set_webinar_attendance").execute(
        { registrationId, status: "attended" },
        { signal },
      ),
    ).rejects.toThrow("did not approve");
    expect(setWebinarRegistrationAttendance).not.toHaveBeenCalled();
  });

  it("uses the owned Store operations after approval and returns only safe mutation results", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(setWebinarRegistrationAttendance).mockResolvedValue({
      ...state.webinarRegistrations[0],
      status: "attended",
      attended_at: "2026-09-01T10:30:00.000Z",
    } as never);

    const attendance = await tool("bento_set_webinar_attendance", refresh).execute(
      { registrationId, status: "attended" },
      { signal },
    );
    expect(setWebinarRegistrationAttendance).toHaveBeenCalledWith({
      data: { registrationId, status: "attended" },
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(JSON.stringify(attendance)).not.toMatch(
      /attendee@example|private-order|private-access|meet\.example|storage\.example/,
    );
  });
});
