import { z } from "zod";
import type {
  CommerceAudienceContactRecord,
  CommerceAudienceEventRecord,
  CommerceAudienceListRecord,
  CommerceProductRecord,
  CommerceWebinarRegistrationRecord,
} from "./commerce";
import { setWebinarRegistrationAttendance } from "./commerce.functions";
import { requireWebMcpUserConfirmation, webMcpResult, type WebMcpTool } from "./webmcp";

export type StoreWebMcpState = {
  products: Array<Pick<CommerceProductRecord, "id" | "title">>;
  audienceContacts: CommerceAudienceContactRecord[];
  audienceEvents: CommerceAudienceEventRecord[];
  webinarRegistrations: CommerceWebinarRegistrationRecord[];
  audienceLists: CommerceAudienceListRecord[];
  audienceListMembers: Array<{ list_id: string; contact_id: string }>;
};

const uuid = z.string().uuid();
const limit = z.number().int().min(1).max(100).default(50);
const webinarReadInput = z
  .object({
    productId: uuid.optional(),
    status: z.enum(["registered", "attended", "no_show", "canceled"]).optional(),
    limit,
  })
  .strict();
const audienceReadInput = z
  .object({ contactId: uuid.optional(), listId: uuid.optional(), limit })
  .strict();
const attendanceInput = z
  .object({
    registrationId: uuid,
    status: z.enum(["registered", "attended", "no_show"]),
  })
  .strict();

const idSchema = { type: "string", format: "uuid" } as const;
const limitSchema = { type: "integer", minimum: 1, maximum: 100, default: 50 } as const;

function webinarRegistration(
  row: Partial<CommerceWebinarRegistrationRecord>,
  productTitles: Map<string, string>,
) {
  return {
    id: row.id,
    productId: row.product_id,
    productTitle: row.product_id ? productTitles.get(row.product_id) || null : null,
    buyerName: row.buyer_name || null,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    timezone: row.timezone,
    status: row.status,
    reminder24hSentAt: row.reminder_24h_sent_at,
    reminder1hSentAt: row.reminder_1h_sent_at,
    replayReadyNotifiedAt: row.replay_ready_notified_at,
    attendedAt: row.attended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createStoreWebMcpTools({
  data,
  refresh,
}: {
  data: StoreWebMcpState | undefined;
  refresh: () => Promise<unknown>;
}): WebMcpTool[] {
  const productTitles = () =>
    new Map((data?.products ?? []).map((product) => [product.id, product.title]));

  return [
    {
      name: "bento_get_webinar_registrations",
      title: "Get webinar registrations",
      description:
        "Lists bounded webinar registration and attendance state for the signed-in creator. Buyer emails, access grants, order IDs, join links, and replay links are omitted.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          productId: idSchema,
          status: {
            type: "string",
            enum: ["registered", "attended", "no_show", "canceled"],
          },
          limit: limitSchema,
        },
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (rawInput, { signal }) => {
        signal.throwIfAborted();
        const input = webinarReadInput.parse(rawInput);
        const rows = data?.webinarRegistrations ?? [];
        const titles = productTitles();
        const registrations = rows
          .filter(
            (row) =>
              (!input.productId || row.product_id === input.productId) &&
              (!input.status || row.status === input.status),
          )
          .slice(0, input.limit)
          .map((row) => webinarRegistration(row, titles));
        return webMcpResult(`Loaded ${registrations.length} webinar registration(s).`, {
          registrations,
          loadedCount: rows.length,
        });
      },
    },
    {
      name: "bento_get_store_audience_activity",
      title: "Get Store audience activity",
      description:
        "Lists bounded audience contact, list membership, and event state for the signed-in creator. Email addresses, customer IDs, order and booking IDs, and event metadata are omitted.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { contactId: idSchema, listId: idSchema, limit: limitSchema },
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (rawInput, { signal }) => {
        signal.throwIfAborted();
        const input = audienceReadInput.parse(rawInput);
        const allContacts = data?.audienceContacts ?? [];
        const allLists = data?.audienceLists ?? [];
        const allMemberships = data?.audienceListMembers ?? [];
        const allEvents = data?.audienceEvents ?? [];
        const listContactIds = input.listId
          ? new Set(
              allMemberships
                .filter((member) => member.list_id === input.listId)
                .map((member) => member.contact_id),
            )
          : null;
        const matchesContact = (contactId: string) =>
          (!input.contactId || contactId === input.contactId) &&
          (!listContactIds || listContactIds.has(contactId));
        const contactNames = new Map(allContacts.map((contact) => [contact.id, contact.name]));
        const contactStatuses = new Map(
          allContacts.map((contact) => [contact.id, contact.marketing_status]),
        );
        const listNames = new Map(allLists.map((list) => [list.id, list.name]));
        const titles = productTitles();
        const contacts = allContacts
          .filter((contact) => matchesContact(contact.id))
          .slice(0, input.limit)
          .map((contact) => ({
            id: contact.id,
            name: contact.name,
            marketingConsent: contact.marketing_consent,
            marketingStatus: contact.marketing_status,
            firstSource: contact.first_source,
            lastSource: contact.last_source,
            firstSeenAt: contact.first_seen_at,
            lastSeenAt: contact.last_seen_at,
            createdAt: contact.created_at,
          }));
        const lists = allLists
          .filter((list) => !input.listId || list.id === input.listId)
          .slice(0, input.limit)
          .map((list) => ({
            id: list.id,
            name: list.name,
            description: list.description,
            memberCount: allMemberships.filter((member) => member.list_id === list.id).length,
            createdAt: list.created_at,
            updatedAt: list.updated_at,
          }));
        const memberships = allMemberships
          .filter(
            (member) =>
              (!input.listId || member.list_id === input.listId) &&
              matchesContact(member.contact_id),
          )
          .slice(0, input.limit)
          .map((member) => ({
            listId: member.list_id,
            listName: listNames.get(member.list_id) || null,
            contactId: member.contact_id,
            contactName: contactNames.get(member.contact_id) || null,
            marketingStatus: contactStatuses.get(member.contact_id) || null,
          }));
        const events = allEvents
          .filter((event) => matchesContact(event.contact_id))
          .slice(0, input.limit)
          .map((event) => ({
            id: event.id,
            contactId: event.contact_id,
            contactName: contactNames.get(event.contact_id) || null,
            eventType: event.event_type,
            sourceType: event.source_type,
            productId: event.product_id,
            productTitle: event.product_id ? titles.get(event.product_id) || null : null,
            amount: event.amount,
            currency: event.currency,
            occurredAt: event.occurred_at,
          }));
        return webMcpResult("Loaded Store audience activity.", {
          contacts,
          lists,
          memberships,
          events,
          loadedCounts: {
            contacts: allContacts.length,
            lists: allLists.length,
            memberships: allMemberships.length,
            events: allEvents.length,
          },
        });
      },
    },
    {
      name: "bento_set_webinar_attendance",
      title: "Set webinar attendance",
      description:
        "Marks an owned, non-canceled webinar registration as registered, attended, or no-show after browser approval.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          registrationId: idSchema,
          status: { type: "string", enum: ["registered", "attended", "no_show"] },
        },
        required: ["registrationId", "status"],
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: async (rawInput, { signal }) => {
        signal.throwIfAborted();
        const input = attendanceInput.parse(rawInput);
        await requireWebMcpUserConfirmation("Set webinar attendance", input);
        signal.throwIfAborted();
        const updated = await setWebinarRegistrationAttendance({ data: input });
        signal.throwIfAborted();
        await refresh();
        signal.throwIfAborted();
        return webMcpResult("Webinar attendance updated.", {
          registration: webinarRegistration(updated, productTitles()),
        });
      },
    },
  ];
}
