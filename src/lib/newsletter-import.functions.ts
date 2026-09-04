/* eslint-disable @typescript-eslint/no-explicit-any -- Import tables are service-role only. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getCreatorEmailCapacity, recordEmailMarketingCapacityBlock } from "./email.server";
import { normalizeEmailRecipient } from "./email-recipient";
import { summarizeSubscriberImportCapacity } from "./newsletter-import";
import { entitlementUpgradeMessage } from "./plans";
import { requirePlanEntitlement } from "./plan.server";

const uuid = z.string().uuid();
const batchSize = 100;

const importInput = z.object({
  publicationId: uuid,
  batchId: uuid,
  rows: z
    .array(
      z.object({
        email: z.string().max(500),
        name: z.string().max(500).optional(),
        list: z.string().max(500).optional(),
      }),
    )
    .min(1)
    .max(10_000),
  consentConfirmed: z.boolean(),
  listName: z.string().trim().min(1).max(80).optional(),
});

const previewInput = z.object({
  publicationId: uuid,
  rows: z
    .array(
      z.object({
        email: z.string().max(500),
        name: z.string().max(500).optional(),
        list: z.string().max(500).optional(),
      }),
    )
    .min(1)
    .max(10_000),
});

export const previewPublicationSubscriberImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => previewInput.parse(input))
  .handler(async ({ data, context }) => {
    await requirePlanEntitlement(
      context.userId,
      "emailMarketing",
      entitlementUpgradeMessage("emailMarketing"),
    );
    const db = supabaseAdmin as any;
    const { data: publication, error: publicationError } = await db
      .from("newsletter_publications")
      .select("id")
      .eq("id", data.publicationId)
      .eq("creator_id", context.userId)
      .neq("status", "archived")
      .maybeSingle();
    if (publicationError) throw new Error(publicationError.message);
    if (!publication) throw new Error("Publication not found.");

    const emails = [
      ...new Set(data.rows.map((row) => normalizeEmailRecipient(row.email)).filter(Boolean)),
    ] as string[];
    const existing = new Map<string, { email_normalized: string; marketing_status: string }>();
    for (let offset = 0; offset < emails.length; offset += 500) {
      const { data: contacts, error } = await db
        .from("audience_contacts")
        .select("email_normalized,marketing_status")
        .eq("creator_id", context.userId)
        .in("email_normalized", emails.slice(offset, offset + 500));
      if (error) throw new Error(error.message);
      for (const contact of contacts ?? []) existing.set(contact.email_normalized, contact);
    }
    const capacity = await getCreatorEmailCapacity(context.userId);
    return summarizeSubscriberImportCapacity(emails, [...existing.values()], capacity.remaining);
  });

function isCapacityError(error: { code?: string; message?: string } | null) {
  return error?.code === "P0001" && /contact allowance/i.test(error.message ?? "");
}

export const importPublicationSubscribers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => importInput.parse(input))
  .handler(async ({ data, context }) => {
    if (!data.consentConfirmed) throw new Error("Confirm subscriber consent before importing.");
    await requirePlanEntitlement(
      context.userId,
      "emailMarketing",
      entitlementUpgradeMessage("emailMarketing"),
    );

    const db = supabaseAdmin as any;
    const { data: publication, error: publicationError } = await db
      .from("newsletter_publications")
      .select("id")
      .eq("id", data.publicationId)
      .eq("creator_id", context.userId)
      .neq("status", "archived")
      .maybeSingle();
    if (publicationError) throw new Error(publicationError.message);
    if (!publication) throw new Error("Publication not found.");

    const normalized: Array<{ email: string; name?: string; lists: string[] }> = [];
    const normalizedByEmail = new Map<string, (typeof normalized)[number]>();
    let invalid = 0;
    let skipped = 0;
    for (const row of data.rows) {
      const email = normalizeEmailRecipient(row.email);
      const name = row.name?.trim();
      const rowList = row.list?.trim();
      if (!email || (name?.length ?? 0) > 120 || (rowList?.length ?? 0) > 80) {
        invalid += 1;
      } else if (normalizedByEmail.has(email)) {
        const existing = normalizedByEmail.get(email)!;
        existing.name ||= name;
        existing.lists = [
          ...new Set(
            [...existing.lists, data.listName, rowList].filter((value): value is string => !!value),
          ),
        ];
        skipped += 1;
      } else {
        const subscriber = {
          email,
          ...(name ? { name } : {}),
          lists: [...new Set([data.listName, rowList].filter((value): value is string => !!value))],
        };
        normalizedByEmail.set(email, subscriber);
        normalized.push(subscriber);
      }
    }

    const listIds = new Map<string, string>();
    const ensureList = async (name: string) => {
      const cached = listIds.get(name);
      if (cached) return cached;
      const find = () =>
        db
          .from("audience_lists")
          .select("id")
          .eq("creator_id", context.userId)
          .eq("publication_id", data.publicationId)
          .eq("name", name)
          .maybeSingle();
      let { data: list, error } = await find();
      if (error) throw new Error(error.message);
      if (!list) {
        const inserted = await db
          .from("audience_lists")
          .insert({
            creator_id: context.userId,
            publication_id: data.publicationId,
            name,
            description: "",
          })
          .select("id")
          .maybeSingle();
        if (inserted.error?.code === "23505") ({ data: list, error } = await find());
        else ({ data: list, error } = inserted);
        if (error) throw new Error(error.message);
      }
      if (!list) throw new Error("Audience list could not be created.");
      listIds.set(name, list.id);
      return list.id as string;
    };

    let imported = 0;
    let updated = 0;
    let blocked = 0;
    for (let offset = 0; offset < normalized.length; offset += batchSize) {
      for (const row of normalized.slice(offset, offset + batchSize)) {
        const { data: contactId, error: contactError } = await db.rpc(
          "commerce_upsert_audience_contact",
          {
            p_creator_id: context.userId,
            p_email: row.email,
            p_name: row.name ?? null,
            p_source: "csv_import",
            p_occurred_at: new Date().toISOString(),
          },
        );
        if (contactError) throw new Error(contactError.message);
        if (typeof contactId !== "string") throw new Error("Audience contact import failed.");

        const [
          { data: existing, error: subscriptionError },
          { data: contact, error: audienceContactError },
        ] = await Promise.all([
          db
            .from("newsletter_subscriptions")
            .select("id,status,email_enabled")
            .eq("publication_id", data.publicationId)
            .eq("contact_id", contactId)
            .maybeSingle(),
          db
            .from("audience_contacts")
            .select("id,marketing_status")
            .eq("id", contactId)
            .eq("creator_id", context.userId)
            .maybeSingle(),
        ]);
        if (subscriptionError) throw new Error(subscriptionError.message);
        if (audienceContactError) throw new Error(audienceContactError.message);
        if (!contact) throw new Error("Audience contact import failed.");

        const globallySubscribed = contact.marketing_status === "subscribed";
        if (
          !existing ||
          existing.status !== "subscribed" ||
          !existing.email_enabled ||
          !globallySubscribed
        ) {
          const proof = {
            publication_id: data.publicationId,
            batch_id: data.batchId,
            disclosure: "newsletter_subscription",
            consent_confirmed: true,
          };
          const idempotencyKey = `${data.batchId}:${data.publicationId}:${contactId}`;
          const { error: consentError } = await db.from("audience_consent_events").insert({
            creator_id: context.userId,
            contact_id: contactId,
            status: "subscribed",
            source: "csv_import",
            idempotency_key: idempotencyKey,
            proof,
          });
          if (isCapacityError(consentError)) {
            blocked += 1;
            await recordEmailMarketingCapacityBlock({
              creatorId: context.userId,
              source: "csv_import",
              error: consentError,
            });
            continue;
          }
          if (consentError && consentError.code !== "23505") throw new Error(consentError.message);

          const { error: upsertError } = await db.from("newsletter_subscriptions").upsert(
            {
              publication_id: data.publicationId,
              contact_id: contactId,
              status: "subscribed",
              email_enabled: true,
              source: "csv_import",
              consent_proof: {
                disclosure: "newsletter_subscription",
                consent_confirmed: true,
              },
              subscribed_at: new Date().toISOString(),
              unsubscribed_at: null,
            },
            { onConflict: "publication_id,contact_id" },
          );
          if (upsertError) throw new Error(upsertError.message);
          if (existing) updated += 1;
          else imported += 1;
        } else {
          skipped += 1;
        }

        for (const listName of row.lists) {
          const listId = await ensureList(listName);
          const { error } = await db
            .from("audience_list_members")
            .upsert({ list_id: listId, contact_id: contactId });
          if (error) throw new Error(error.message);
        }
      }
    }

    return { imported, updated, skipped, invalid, blocked };
  });
