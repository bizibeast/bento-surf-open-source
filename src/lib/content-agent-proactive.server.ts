import { withProviderBudgetWorkspace } from "./provider-budget.server";
import { proactiveDeliveryAvailable, proactiveWorkspaceIds } from "./content-agent-config.server";
import { recordContentEvent } from "./content-workspace-analytics.server";
/* eslint-disable @typescript-eslint/no-explicit-any -- New durable RPCs are server-only and owner-scoped. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireContentWorkspace } from "./content-access.server";
import { getContentAgentPreferencesForWorkspace } from "./content-agent-identity.server";
import { contentAgentCardSchema, contentAgentResultSchema } from "./content-agent";
import { loadContentEditorialContext } from "./content-agent.server";
import { buildEditorialBrief, isAutomaticEditorialFormat } from "./content-editorial";
import { generateEditorialDraft } from "./content-editorial.server";
import { discoverPostKey } from "./content-discover-identity";
import {
  contentTopicKeys,
  topicIsSuppressed,
  type ProactivePayload,
} from "./content-agent-proactive";
import { missingPostingSlots } from "./content-routines";
import type { PostingSchedule, SchedulerPost } from "./social-scheduler";
import type { EditorialPlatform } from "./content-editorial";
import type { PreparedRoutineOutput } from "./content-routine-output.server";

export type ContentSignalInput = {
  userId: string;
  kind: "fresh_source" | "schedule_gap" | "prepared_routine";
  sourceIds: string[];
  observedAt: string;
};
export type ClaimedContentSignal = {
  id: string;
  user_id: string;
  kind: ContentSignalInput["kind"];
  source_ids: string[];
  observed_at: string;
  lease_key: string;
  attempts: number;
  fingerprint?: string;
};
const canonicalIds = (ids: string[]) =>
  [
    ...new Set(
      ids.map((id) => (/^https?:\/\//i.test(id) ? discoverPostKey({ sourceUrl: id }) : id)),
    ),
  ].sort();
export async function contentSignalFingerprint(input: Omit<ContentSignalInput, "userId">) {
  // Original sources and prepared runs are lifetime identities. Only schedule gaps recur weekly.
  const bucket =
    input.kind === "schedule_gap" ? Math.floor(Date.parse(input.observedAt) / (7 * 86400000)) : "";
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([input.kind, canonicalIds(input.sourceIds), bucket])),
  );
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}
async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await (supabaseAdmin as any).rpc(name, args);
  if (error) throw new Error("Agent background work could not be saved.");
  return data;
}
export async function enqueueContentAgentSignal(input: ContentSignalInput) {
  if (!proactiveDeliveryAvailable(input.userId)) return null;
  if (
    !input.sourceIds.length ||
    input.sourceIds.length > 40 ||
    !Number.isFinite(Date.parse(input.observedAt))
  )
    throw new Error("Invalid Agent signal.");
  return rpc("enqueue_content_agent_signal", {
    p_user_id: input.userId,
    p_kind: input.kind,
    p_fingerprint: await contentSignalFingerprint(input),
    p_source_ids: canonicalIds(input.sourceIds),
    p_observed_at: input.observedAt,
  });
}
export async function authorizeContentAgentWork(userId: string) {
  await requireContentWorkspace(userId, "contentAgent");
  const { data, error } = await (supabaseAdmin as any)
    .from("profiles")
    .select("id,workspace_status")
    .eq("id", userId)
    .maybeSingle();
  if (error || !data || data.workspace_status !== "active")
    throw new Error("Content workspace is inactive.");
}
const cutoff = () => new Date(Date.now() - 7 * 86400000).toISOString();
/** Normalize bounded batches with the same identity implementation as Discover. */
async function recommendationPage(userId: string) {
  const unindexed: any[] = await rpc("unindexed_content_agent_sources", { p_user_id: userId });
  if (unindexed.length)
    await rpc("index_content_agent_sources", {
      p_user_id: userId,
      p_rows: unindexed.map((row) => ({
        id: row.id,
        sourceUrl: row.source_url,
        fingerprint: row.fingerprint,
        sourceKey: postKey(row),
      })),
    });
  return (await rpc("claim_content_agent_recommendations", { p_user_id: userId })) as any[];
}
async function suppressedTopics(userId: string, keys: string[]): Promise<string[]> {
  if (!keys.length) return [];
  return rpc("content_agent_suppressed_topics", {
    p_user_id: userId,
    p_keys: [...new Set(keys)].slice(0, 1600),
  });
}
async function suppressedSources(userId: string, keys: string[]): Promise<string[]> {
  if (!keys.length) return [];
  return rpc("content_agent_suppressed_sources", {
    p_user_id: userId,
    p_keys: [...new Set(keys)].slice(0, 1600),
  });
}
const postKey = (row: any) =>
  discoverPostKey({ sourceUrl: row.source_url, fingerprint: row.fingerprint });
export function usefulDiscoverSources(rows: any[], now = Date.now()) {
  // Feedback applies to every source/idea variant of the same original post.
  const excluded = new Set(
    rows
      .filter(
        (row) =>
          row.feedback === "saved" ||
          row.feedback === "not_relevant" ||
          row.metadata?.saved === true,
      )
      .map(postKey),
  );
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = postKey(row);
    const age = now - Date.parse(row.source_published_at || "");
    if (
      !key ||
      seen.has(key) ||
      excluded.has(key) ||
      !row.source_url ||
      !(age >= 0 && age <= 7 * 86400000) ||
      row.summary.trim().length < 100 ||
      row.reason.trim().length < 20
    )
      return false;
    seen.add(key);
    return true;
  });
}
/** Trigger-fed scans rotate hourly, so paused/capped/seen workspaces cannot occupy the first page. */
export async function scanContentAgentSignals(limit = 3) {
  const workspaceIds = proactiveWorkspaceIds();
  if (workspaceIds?.length === 0) return { checked: 0, enqueued: 0 };
  const users: string[] = await rpc("claim_content_agent_scans", {
    p_limit: limit,
    p_workspace_ids: workspaceIds,
  });
  let enqueued = 0;
  for (const userId of users) {
    try {
      await authorizeContentAgentWork(userId);
      const prefs = await getContentAgentPreferencesForWorkspace(userId);
      if (prefs.proactive_paused || !prefs.platforms.length) continue;
      enqueued += await enqueuePreparedRoutineSignals(userId);
      enqueued += await enqueueFreshSourceSignals(userId);
    } catch {
      /* One workspace never blocks the rest of the minute cron. */
    }
  }
  return { checked: users.length, enqueued };
}
/** Advance past already-seen originals instead of repeatedly enqueuing the first three. */
export async function enqueueFreshSourceSignals(userId: string) {
  if (!proactiveDeliveryAvailable(userId)) return 0;
  const rows = usefulDiscoverSources(await recommendationPage(userId));
  const blocked = await suppressedTopics(
    userId,
    rows.flatMap((row) => contentTopicKeys(row.title || "")),
  );
  const candidates = await Promise.all(
    rows
      .filter((row) => !topicIsSuppressed(contentTopicKeys(row.title || ""), blocked))
      .map(async (row) => {
        const input: ContentSignalInput = {
          userId,
          kind: "fresh_source",
          sourceIds: [row.source_url],
          observedAt: row.source_published_at,
        };
        return { input, fingerprint: await contentSignalFingerprint(input) };
      }),
  );
  if (!candidates.length) return 0;
  const { data, error } = await (supabaseAdmin as any)
    .from("content_agent_signals")
    .select("fingerprint")
    .eq("user_id", userId)
    .in(
      "fingerprint",
      candidates.map((item) => item.fingerprint),
    );
  if (error) throw new Error("Source delivery state could not load.");
  const seen = new Set((data || []).map((row: any) => row.fingerprint));
  const next = candidates.filter((item) => !seen.has(item.fingerprint)).slice(0, 3);
  for (const { input } of next) await enqueueContentAgentSignal(input);
  return next.length;
}
/** Also used by the morning check-in; it never generates duplicate routine posts. */
export async function enqueuePreparedRoutineSignals(userId: string) {
  if (!proactiveDeliveryAvailable(userId)) return 0;
  await authorizeContentAgentWork(userId);
  const { data, error } = await (supabaseAdmin as any)
    .from("content_routine_runs")
    .select("id,prepared_output,scheduled_for")
    .eq("user_id", userId)
    .not("prepared_output", "is", null)
    .gte("scheduled_for", cutoff())
    .order("scheduled_for", { ascending: false })
    .limit(20);
  if (error) throw new Error("Prepared routine work could not be loaded.");
  const candidates = await Promise.all(
    (data || [])
      .filter((run: any) => {
        const batch = run.prepared_output as PreparedRoutineOutput;
        return (
          batch.drafts?.some((binding) => binding.card.editorial?.validationState === "passed") ||
          (batch.result?.action === "answer" && batch.adviceEvidence?.sourceIds.length)
        );
      })
      .map(async (run: any) => ({
        run,
        fingerprint: await contentSignalFingerprint({
          kind: "prepared_routine",
          sourceIds: [run.id],
          observedAt: run.scheduled_for,
        }),
      })),
  );
  if (!candidates.length) return 0;
  const { data: existing, error: signalError } = await (supabaseAdmin as any)
    .from("content_agent_signals")
    .select("fingerprint,status")
    .eq("user_id", userId)
    .in(
      "fingerprint",
      candidates.map((item) => item.fingerprint),
    );
  if (signalError) throw new Error("Prepared delivery state could not load.");
  const completed = new Set(
    (existing || [])
      .filter((row: any) => ["delivered", "skipped", "failed"].includes(row.status))
      .map((row: any) => row.fingerprint),
  );
  let count = 0;
  for (const { run, fingerprint } of candidates) {
    if (completed.has(fingerprint)) continue;
    await enqueueContentAgentSignal({
      userId,
      kind: "prepared_routine",
      sourceIds: [run.id],
      observedAt: run.scheduled_for,
    });
    count++;
  }
  return count;
}

/** Count only matching platform slots in the next seven days; unassigned drafts never occupy one. */
export function upcomingContentGap(
  schedule: PostingSchedule,
  rows: any[],
  platforms: EditorialPlatform[],
  now = new Date(),
) {
  const horizon = { from: now, until: new Date(now.getTime() + 7 * 86400000 - 1) };
  const configured = missingPostingSlots(schedule, [], horizon);
  for (const platform of platforms) {
    const posts: SchedulerPost[] = rows.flatMap((row) => {
      const prepared =
        row.status === "draft" &&
        row.settings?.routineOutputReady === true &&
        row.settings?.routineRunId &&
        row.settings?.platform === platform &&
        row.body?.trim();
      const relevant =
        row.status !== "draft" &&
        (row.targets || []).some(
          (target: any) =>
            target.provider === platform && !["failed", "cancelled"].includes(target.status),
        );
      if (!prepared && !relevant) return [];
      let scheduledAt = prepared ? row.settings.routineSlotAt : row.scheduled_at;
      if (!scheduledAt) return [];
      const date = new Date(scheduledAt);
      if (!Number.isFinite(date.getTime()) || date < horizon.from || date > horizon.until)
        return [];
      if (schedule.naturalOffset)
        scheduledAt =
          configured.find(
            (slot) => Math.abs(Date.parse(slot.scheduledAt) - date.getTime()) <= 15 * 60000,
          )?.scheduledAt || scheduledAt;
      return [
        {
          id: row.id,
          body: row.body || "",
          title: row.title || null,
          scheduledAt,
          timezone: schedule.timezone,
          status: prepared ? "scheduled" : row.status,
          media: [],
          createdAt: row.created_at || "",
          targets: [],
        },
      ];
    });
    const first = missingPostingSlots(schedule, posts, horizon)[0];
    if (first) return { platform, scheduledAt: first.scheduledAt };
  }
  return null;
}
async function loadUpcomingContentGap(userId: string, platforms: EditorialPlatform[]) {
  const db = supabaseAdmin as any;
  const now = new Date();
  const until = new Date(now.getTime() + 7 * 86400000).toISOString();
  const [schedule, scheduled, prepared] = await Promise.all([
    db
      .from("social_posting_schedules")
      .select("timezone,slots,natural_offset")
      .eq("user_id", userId)
      .maybeSingle(),
    db
      .from("social_posts")
      .select("id,status,body,scheduled_at,targets:social_post_targets(provider,status)")
      .eq("user_id", userId)
      .gte("scheduled_at", now.toISOString())
      .lte("scheduled_at", until)
      .order("scheduled_at")
      .limit(200),
    db
      .from("social_posts")
      .select("id,status,body,settings")
      .eq("user_id", userId)
      .eq("status", "draft")
      .eq("settings->>routineOutputReady", "true")
      .gte("settings->>routineSlotAt", now.toISOString())
      .lte("settings->>routineSlotAt", until)
      .order("created_at")
      .limit(200),
  ]);
  if (schedule.error || scheduled.error || prepared.error)
    throw new Error("Upcoming posting slots could not load.");
  if (!schedule.data) return null;
  return upcomingContentGap(
    {
      timezone: schedule.data.timezone,
      slots: schedule.data.slots || [],
      naturalOffset: Boolean(schedule.data.natural_offset),
    },
    [...(scheduled.data || []), ...(prepared.data || [])],
    platforms,
    now,
  );
}

export async function prepareContentAgentSignal(
  signal: ClaimedContentSignal,
): Promise<ProactivePayload | null> {
  const prefs = await getContentAgentPreferencesForWorkspace(signal.user_id);
  if (prefs.proactive_paused || !prefs.platforms.length) return null;
  const metadata: NonNullable<ProactivePayload["proactive"]> = {
    signalId: signal.id,
    signalKey: signal.fingerprint || signal.id,
    whyNow: "",
    topicKeys: [],
    sourceKeys: [],
    feedback: null,
    feedbackActions: ["useful", "not_relevant", "less_like_this"],
    draftBindings: [],
  };
  if (signal.kind === "prepared_routine") {
    const { data: run, error } = await (supabaseAdmin as any)
      .from("content_routine_runs")
      .select("id,routine_id,prepared_output")
      .eq("id", signal.source_ids[0])
      .eq("user_id", signal.user_id)
      .maybeSingle();
    if (error) throw new Error("Prepared work could not load.");
    const batch = run?.prepared_output as PreparedRoutineOutput | undefined;
    if (
      !batch ||
      batch.version !== 1 ||
      batch.userId !== signal.user_id ||
      batch.runId !== run.id ||
      batch.routineId !== run.routine_id
    )
      return null;
    const result = contentAgentResultSchema.parse(batch.result);
    const cards: ProactivePayload["cards"] = [];
    const draftStates: NonNullable<ProactivePayload["draftStates"]> = {};
    for (const binding of batch.drafts.slice(0, 20)) {
      if (binding.runId !== batch.runId) continue;
      const original = contentAgentCardSchema.parse(binding.card);
      if (
        original.type !== "draft" ||
        original.editorial?.validationState !== "passed" ||
        !original.editorial.sourceIds.some((id) => id !== "request") ||
        !prefs.platforms.includes(original.platform as any) ||
        !isAutomaticEditorialFormat(original.platform, original.format)
      )
        continue;
      const { data: post, error: postError } = await (supabaseAdmin as any)
        .from("social_posts")
        .select("id,title,body,status,settings,updated_at")
        .eq("id", binding.socialPostId)
        .eq("user_id", signal.user_id)
        .maybeSingle();
      if (postError) throw new Error("Prepared draft could not load.");
      if (!post || post.status !== "draft" || !post.body?.trim()) continue;
      if (
        (post.settings?.routineRunId && post.settings.routineRunId !== batch.runId) ||
        (post.settings?.card?.cardId && post.settings.card.cardId !== original.cardId)
      )
        continue;
      const checked = contentAgentCardSchema.safeParse(post.settings?.card);
      const checkedCard =
        checked.success && checked.data.type === "draft" ? checked.data : original;
      const edited =
        !checked.success ||
        checked.data.type !== "draft" ||
        checkedCard.editorial?.validationState !== "passed" ||
        post.body !== checkedCard.body ||
        (post.title || "") !== checkedCard.title;
      cards.push({
        ...checkedCard,
        body: post.body,
        title: post.title || "",
        editorial: { ...original.editorial, validationState: edited ? "needs_review" : "passed" },
      });
      if (post.settings?.agentDraftState && post.updated_at) {
        draftStates[original.cardId] = {
          ...post.settings.agentDraftState,
          socialPostId: post.id,
          postUpdatedAt: post.updated_at,
        };
      }
      metadata.sourceKeys.push(
        ...original.sourceUrls.map((url) => discoverPostKey({ sourceUrl: url })),
        ...original.editorial.sourceIds.filter((id) => !/^(brain:|request$)/.test(id)),
      );
      metadata.topicKeys = contentTopicKeys(
        ...cards.flatMap((card) =>
          card.type === "draft" ? [card.title, card.editorial?.angle || card.rationale] : [],
        ),
      );
      metadata.draftBindings.push({
        cardId: original.cardId,
        socialPostId: post.id,
        runId: batch.runId,
        body: post.body,
        title: post.title || "",
      });
    }
    if (cards.length) {
      metadata.whyNow =
        "Your routine prepared these sourced drafts for your next posting slots. Review the current saved copy before scheduling.";
      return {
        action: "draft",
        message: `${cards.length === 1 ? "A draft is" : `${cards.length} drafts are`} ready for your review.`,
        cards,
        draftStates,
        proactive: metadata,
      };
    }
    if (
      result.action === "answer" &&
      result.cards.length === 0 &&
      result.message.length >= 120 &&
      batch.adviceEvidence?.sourceIds.length
    ) {
      metadata.sourceKeys = batch.adviceEvidence.sourceIds.filter(
        (id) => !/^(brain:|request$)/.test(id),
      );
      metadata.topicKeys = contentTopicKeys(result.message);
      metadata.whyNow = "Your weekly review connects recent evidence with practical next steps.";
      return { ...result, proactive: metadata };
    }
    return null;
  }
  const gap =
    signal.kind === "schedule_gap"
      ? await loadUpcomingContentGap(signal.user_id, prefs.platforms)
      : null;
  if (signal.kind === "schedule_gap" && !gap) return null;
  const context = await loadContentEditorialContext(
    signal.user_id,
    "",
    gap?.platform || prefs.platforms[0],
  );
  if (signal.kind === "fresh_source") {
    const rows: any[] = await rpc("get_content_agent_source", {
      p_user_id: signal.user_id,
      p_source_key: signal.source_ids[0],
    });
    const selected = usefulDiscoverSources(rows).find((row) =>
      signal.source_ids.includes(postKey(row)),
    );
    if (!selected) return null;
    metadata.topicKeys = contentTopicKeys(selected.title);
    if (
      topicIsSuppressed(
        metadata.topicKeys,
        await suppressedTopics(signal.user_id, metadata.topicKeys),
      )
    )
      return null;
    context.request = `Develop the specific reader benefit of this new source: ${selected.title}. Relevance: ${selected.reason}`;
    context.sources = [
      {
        id: postKey(selected),
        title: selected.title,
        text: selected.summary,
        url: selected.source_url,
        occurredAt: selected.source_published_at,
        external: true,
      },
      ...context.sources.filter((source) => !source.external),
    ];
    metadata.whyNow = selected.reason;
  } else if (gap) {
    metadata.gap = gap;
    context.request = `Prepare one useful evidence-backed ${gap.platform} draft for the configured posting slot at ${gap.scheduledAt}.`;
    metadata.whyNow = `Your configured ${gap.platform} posting slot at ${gap.scheduledAt} is still open.`;
  }
  const blockedTopics = await suppressedTopics(
    signal.user_id,
    context.sources.flatMap((source) => contentTopicKeys(source.title)),
  );
  const sourceIdentity = (source: (typeof context.sources)[number]) =>
    source.url ? discoverPostKey({ sourceUrl: source.url }) : source.id;
  const blockedSources = new Set(
    await suppressedSources(signal.user_id, context.sources.map(sourceIdentity)),
  );
  context.sources = context.sources.filter(
    (source) =>
      !blockedSources.has(sourceIdentity(source)) &&
      !topicIsSuppressed(contentTopicKeys(source.title), blockedTopics),
  );
  const brief = buildEditorialBrief(context);
  // Context/voice alone should not become an unsolicited generic draft.
  if (!brief.sources.some((source) => source.id !== "request" && source.text.trim().length >= 100))
    return null;
  const checked = await generateEditorialDraft(brief, { timeoutMs: 30000 });
  void recordContentEvent(signal.user_id, "content_agent_draft_review", {
    status: checked.status,
    count: 1,
  });
  if (checked.issues?.some((issue) => ["repeated_argument", "novelty"].includes(issue.code)))
    void recordContentEvent(signal.user_id, "content_agent_novelty_rejection", {
      issue: "repeated_argument",
      count: 1,
    });
  if (checked.status === "retry") throw new Error("Editorial preparation interrupted.");
  if (
    checked.status !== "ready" ||
    checked.card.type !== "draft" ||
    !checked.card.editorial?.sourceIds.some((id) => id !== "request")
  )
    return null;
  return {
    action: "draft",
    message: "A sourced draft for your review.",
    cards: [checked.card],
    proactive: {
      ...metadata,
      sourceKeys: canonicalIds([
        ...checked.card.sourceUrls,
        ...checked.card.editorial.sourceIds.filter((id) => !/^(brain:|request$)/.test(id)),
      ]),
      topicKeys: contentTopicKeys(
        ...metadata.topicKeys.map((key) => key.replace(/^subject:/, "")),
        checked.card.title,
        checked.card.editorial.angle,
      ),
      whyNow: checked.card.editorial.whyNow || metadata.whyNow,
    },
  };
}
export type ProactiveDependencies = {
  claim(limit: number): Promise<ClaimedContentSignal[]>;
  authorize(userId: string): Promise<unknown>;
  prepare(signal: ClaimedContentSignal): Promise<ProactivePayload | null>;
  finish(signal: ClaimedContentSignal, payload: ProactivePayload): Promise<string | null>;
  release(signal: ClaimedContentSignal, status: "pending" | "failed" | "skipped"): Promise<unknown>;
};
const ownership = (signal: ClaimedContentSignal) => ({
  p_user_id: signal.user_id,
  p_signal_id: signal.id,
  p_lease_key: signal.lease_key,
});
const production: ProactiveDependencies = {
  claim: async (limit) => {
    const workspaceIds = proactiveWorkspaceIds();
    return workspaceIds === null || workspaceIds.length
      ? rpc("claim_due_content_agent_signals", { p_limit: limit, p_workspace_ids: workspaceIds })
      : [];
  },
  authorize: async (userId) => {
    if (!proactiveDeliveryAvailable(userId)) throw new Error("Proactive delivery is unavailable.");
    await authorizeContentAgentWork(userId);
  },
  prepare: prepareContentAgentSignal,
  finish: async (signal, payload) => {
    const enabled = proactiveDeliveryAvailable(signal.user_id);
    const messageId = await rpc("finish_content_agent_signal", {
      ...ownership(signal),
      p_payload: payload,
      p_rollout_enabled: enabled,
    });
    if (messageId) {
      try {
        const { prepareAgentMessage } = await import("./content-agent-preparation.server");
        await prepareAgentMessage(signal.user_id, messageId);
      } catch {
        /* The durable message retains its explicit visual readiness state. */
      }
      try {
        const { enqueueSavedDraftImages } = await import("./content-agent-images.server");
        await enqueueSavedDraftImages(signal.user_id, messageId);
      } catch {
        /* Delivery is already durable. */
      }
      const draftCount = payload.cards.filter((card) => card.type === "draft").length;
      if (draftCount) {
        const { notifyContentDraftsReady } = await import("./content-notifications.server");
        await notifyContentDraftsReady({
          userId: signal.user_id,
          runId: signal.id,
          draftCount,
          platforms: [
            ...new Set(
              payload.cards.flatMap((card) => (card.type === "draft" ? [card.platform] : [])),
            ),
          ],
        }).catch(() => {
          /* Keep delivered drafts available if a notification channel is down. */
        });
      }
    }
    return messageId;
  },
  release: (signal, status) =>
    rpc("release_content_agent_signal", { ...ownership(signal), p_status: status }),
};
export async function processDueContentAgentSignals(
  limit = 1,
  dependencies: ProactiveDependencies = production,
) {
  const signals = await dependencies.claim(Math.max(1, Math.min(limit, 5)));
  let delivered = 0;
  let skipped = 0;
  let failed = 0;
  // Sequential bounded work; production requests one lease per tick.
  for (const signal of signals) {
    try {
      if (Date.parse(signal.observed_at) < Date.now() - 7 * 86400000) {
        await dependencies.release(signal, "skipped");
        skipped++;
        void recordContentEvent(signal.user_id, "content_agent_delivery", {
          status: "skipped",
          count: 1,
        });
        continue;
      }
      await dependencies.authorize(signal.user_id);
      const payload = await withProviderBudgetWorkspace(signal.user_id, () =>
        dependencies.prepare(signal),
      );
      if (!payload) {
        await dependencies.release(signal, "skipped");
        skipped++;
        void recordContentEvent(signal.user_id, "content_agent_delivery", {
          status: "skipped",
          count: 1,
        });
        continue;
      }
      await dependencies.authorize(signal.user_id);
      if (
        await withProviderBudgetWorkspace(signal.user_id, () =>
          dependencies.finish(signal, payload),
        )
      ) {
        delivered++;
        void recordContentEvent(signal.user_id, "content_agent_delivery", {
          status: "delivered",
          count: 1,
        });
      }
    } catch {
      failed++;
      void recordContentEvent(signal.user_id, "content_agent_delivery", {
        status: "failed",
        count: 1,
      });
      try {
        await dependencies.release(signal, signal.attempts >= 3 ? "failed" : "pending");
      } catch {
        /* Lease expires naturally. */
      }
    }
  }
  return { claimed: signals.length, delivered, skipped, failed };
}
