/* eslint-disable @typescript-eslint/no-explicit-any -- email_outbox and the digest RPC are not in the generated types. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { EnqueueEmailInput } from "./email.server";
import {
  configuredWeeklyDigestCap,
  dueWeeklyDigestCohorts,
  selectWeeklyDigests,
  utcDateDaysAgo,
  type WeeklyDigestDraft,
  type WeeklyDigestPage,
} from "./weekly-digest";

export type ExistingDigestRow = { eventKey: string; createdAt: string };

type DigestDeps = {
  loadPages?: (since: string) => Promise<WeeklyDigestPage[]>;
  /** Outbox rows that already exist for these keys, with when they were queued. */
  existingKeys?: (keys: string[]) => Promise<ExistingDigestRow[]>;
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

async function loadExistingDigestKeys(keys: string[]): Promise<ExistingDigestRow[]> {
  const rows: ExistingDigestRow[] = [];
  for (let offset = 0; offset < keys.length; offset += 100) {
    const { data, error } = await (supabaseAdmin as any)
      .from("email_outbox")
      .select("event_key,created_at")
      .in("event_key", keys.slice(offset, offset + 100));
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Array<{ event_key: string; created_at: string }>) {
      rows.push({ eventKey: row.event_key, createdAt: row.created_at });
    }
  }
  return rows;
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

/**
 * Runs once a day. Monday queues cohort 0, Tuesday adds cohort 1, and every
 * later day of the ISO week picks up anyone the daily cap held back. Each
 * person has one event key per week, so a rerun never queues a second copy.
 */
export async function enqueueWeeklyDigests(now = new Date(), deps: DigestDeps = {}) {
  const cohorts = dueWeeklyDigestCohorts(now);
  if (!cohorts.length) return { enqueued: 0, considered: 0 };
  const cap = deps.cap ?? configuredWeeklyDigestCap();
  if (cap <= 0) return { enqueued: 0, considered: 0 };
  const pages = await (deps.loadPages ?? loadWeeklyDigestPages)(utcDateDaysAgo(now, 7));
  const planned = selectWeeklyDigests(pages, { now, cap: Number.MAX_SAFE_INTEGER, cohorts });
  const existing = await (deps.existingKeys ?? loadExistingDigestKeys)(
    planned.map((draft) => draft.eventKey),
  );
  const today = now.toISOString().slice(0, 10);
  const queuedToday = existing.filter((row) => {
    const createdAt = Date.parse(row.createdAt);
    // An unreadable timestamp counts against today's cap rather than past it.
    return !Number.isFinite(createdAt) || new Date(createdAt).toISOString().slice(0, 10) === today;
  }).length;
  const remaining = Math.max(0, cap - queuedToday);
  const selected = selectWeeklyDigests(pages, {
    now,
    cap: remaining,
    cohorts,
    existingEventKeys: existing.map((row) => row.eventKey),
  });
  if (!selected.length) return { enqueued: 0, considered: pages.length };
  const enqueue = deps.enqueue ?? (await import("./email.server")).enqueueEmailBatch;
  const batch = await enqueue(selected.map(toOutboxInput));
  return {
    enqueued: batch.rows.length,
    considered: pages.length,
    heldBack: planned.length - existing.length - selected.length,
  };
}
