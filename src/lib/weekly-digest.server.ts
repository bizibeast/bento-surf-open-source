import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { EnqueueEmailInput } from "./email.server";
import {
  configuredWeeklyDigestCap,
  selectWeeklyDigests,
  shouldEnqueueWeeklyDigest,
  utcDateDaysAgo,
  type WeeklyDigestDraft,
  type WeeklyDigestPage,
} from "./weekly-digest";

type DigestDeps = {
  loadPages?: (since: string) => Promise<WeeklyDigestPage[]>;
  existingKeys?: (keys: string[]) => Promise<string[]>;
  enqueue?: (inputs: EnqueueEmailInput[]) => Promise<{ rows: Array<{ id: string }> }>;
  cap?: number;
};

function asCount(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function asText(value: unknown) {
  return typeof value === "string" ? value : "";
}

async function loadWeeklyDigestPages(since: string): Promise<WeeklyDigestPage[]> {
  const { data, error } = await (supabaseAdmin as any).rpc("weekly_digest_page_stats", {
    p_since: since,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    authUserId: asText(row.auth_user_id),
    email: asText(row.email),
    recipientName: asText(row.recipient_name) || null,
    workspaceId: asText(row.workspace_id),
    username: asText(row.username),
    views: asCount(row.views),
    clicks: asCount(row.clicks),
    sales: asCount(row.sales),
  }));
}

async function loadExistingDigestKeys(keys: string[]) {
  if (!keys.length) return [];
  const { data, error } = await (supabaseAdmin as any)
    .from("email_outbox")
    .select("event_key")
    .in("event_key", keys);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ event_key: string }>).map((row) => row.event_key);
}

function toOutboxInput(draft: WeeklyDigestDraft): EnqueueEmailInput {
  return {
    eventKey: draft.eventKey,
    eventType: "weekly_digest",
    category: "marketing",
    recipientEmail: draft.email,
    recipientName: draft.recipientName,
    userId: draft.authUserId,
    payload: {
      views: draft.views,
      clicks: draft.clicks,
      sales: draft.sales,
      pages: draft.pages,
    },
    immediate: true,
  };
}

export async function enqueueWeeklyDigests(now = new Date(), deps: DigestDeps = {}) {
  if (!shouldEnqueueWeeklyDigest(now)) return { enqueued: 0, considered: 0 };
  const pages = await (deps.loadPages ?? loadWeeklyDigestPages)(utcDateDaysAgo(now, 7));
  const cap = deps.cap ?? configuredWeeklyDigestCap();
  const planned = selectWeeklyDigests(pages, { now, cap: Number.MAX_SAFE_INTEGER });
  const existing = await (deps.existingKeys ?? loadExistingDigestKeys)(planned.map((draft) => draft.eventKey));
  const selected = selectWeeklyDigests(pages, { now, cap, existingEventKeys: existing });
  if (!selected.length) return { enqueued: 0, considered: pages.length };
  const enqueue =
    deps.enqueue ??
    (await import("./email.server")).enqueueEmailBatch;
  const batch = await enqueue(selected.map(toOutboxInput));
  return { enqueued: batch.rows.length, considered: pages.length };
}
