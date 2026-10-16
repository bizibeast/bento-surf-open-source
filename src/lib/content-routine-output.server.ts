/* eslint-disable @typescript-eslint/no-explicit-any -- Routine output is scoped to its creator. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isAutomaticEditorialFormat } from "./content-editorial";
import {
  contentAgentCardSchema,
  contentAgentResultSchema,
  type ContentAgentResult,
} from "./content-agent";

/** Numeric identities retain legacy IDs; new preparation uses the original cardId. */
export async function routinePostId(runId: string, identity: number | string) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`content-routine:${runId}:${identity}`),
  );
  const bytes = new Uint8Array(hash).slice(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Prepared here; Task 5's cadence service is the only automatic chat delivery authority. */
export type PreparedRoutineOutput = {
  version: 1;
  runId: string;
  routineId: string;
  userId: string;
  result: ContentAgentResult;
  adviceEvidence?: { sourceIds: string[] };
  drafts: Array<{
    socialPostId: string;
    runId: string;
    card: Extract<ContentAgentResult["cards"][number], { type: "draft" }>;
  }>;
};

/** Idempotent insert-only preparation. Never schedule or overwrite a creator's post. */
export async function saveRoutineOutputs(
  input: {
    userId: string;
    runId: string;
    routineId: string;
    result: ContentAgentResult;
    adviceEvidence?: { sourceIds: string[] };
    outputMode?: "draft" | "schedule";
    platforms: string[];
    slots: Array<{ scheduledAt: string }>;
    timezone: string;
  },
  dependencies = { db: supabaseAdmin as any },
) {
  const { db } = dependencies;
  if (input.outputMode === "schedule")
    throw new Error(
      "Review this routine: every post now requires creator review before scheduling.",
    );
  if (new Set(input.result.cards.map((card) => card.cardId)).size !== input.result.cards.length)
    throw new Error("Routine output contains duplicate card identities.");
  const drafts = input.result.cards.filter((card) => card.type === "draft");
  if (
    drafts.some((card) => !isAutomaticEditorialFormat(card.platform, card.format)) ||
    input.platforms.some((platform) => !["twitter", "linkedin", "instagram"].includes(platform))
  )
    throw new Error(
      "Choose a supported automatic format: X post, LinkedIn post, or Instagram carousel.",
    );
  if (input.platforms.length && drafts.some((card) => !input.platforms.includes(card.platform)))
    throw new Error("Draft platform does not match the reviewed routine.");
  const { data: run, error: runError } = await db
    .from("content_routine_runs")
    .select("id,prepared_output")
    .eq("id", input.runId)
    .eq("user_id", input.userId)
    .eq("routine_id", input.routineId)
    .maybeSingle();
  if (runError || !run) throw new Error("This routine run is unavailable.");
  const prepared: PreparedRoutineOutput = {
    version: 1,
    ...(input.adviceEvidence ? { adviceEvidence: input.adviceEvidence } : {}),
    userId: input.userId,
    runId: input.runId,
    routineId: input.routineId,
    result: { ...input.result, cards: [] },
    drafts: [],
  };
  const canonical = new Map<string, PreparedRoutineOutput["drafts"][number]>();
  const recover = (row: any, boundCard?: unknown) => {
    const stored = contentAgentCardSchema.safeParse(row.settings?.card || boundCard);
    if (
      (!boundCard &&
        (row.settings?.routineRunId !== input.runId ||
          row.settings?.routineId !== input.routineId)) ||
      (row.settings?.routineRunId && row.settings.routineRunId !== input.runId) ||
      (row.settings?.routineId && row.settings.routineId !== input.routineId) ||
      !stored.success ||
      stored.data.type !== "draft" ||
      !isAutomaticEditorialFormat(stored.data.platform, stored.data.format)
    )
      throw new Error("A saved routine draft could not be verified.");
    const card = { ...stored.data, title: row.title ?? "", body: row.body };
    const prior = canonical.get(card.cardId);
    if (prior && prior.socialPostId !== row.id)
      throw new Error(
        "Multiple saved posts share a routine card identity. Review this batch before retrying.",
      );
    canonical.set(card.cardId, { socialPostId: row.id, runId: input.runId, card });
  };
  // Completed preparation is also a durable binding when a later scheduler edit
  // replaces post settings. Always re-read that exact post with workspace ownership.
  const priorBatch = run.prepared_output;
  if (priorBatch) {
    if (
      priorBatch.version !== 1 ||
      priorBatch.userId !== input.userId ||
      priorBatch.runId !== input.runId ||
      priorBatch.routineId !== input.routineId ||
      !Array.isArray(priorBatch.drafts) ||
      priorBatch.drafts.length > 20
    )
      throw new Error("The prior routine preparation could not be verified.");
    for (const binding of priorBatch.drafts) {
      const card = contentAgentCardSchema.safeParse(binding.card);
      if (
        binding.runId !== input.runId ||
        typeof binding.socialPostId !== "string" ||
        !card.success ||
        card.data.type !== "draft"
      )
        throw new Error("The prior routine binding could not be verified.");
      const { data: post, error } = await db
        .from("social_posts")
        .select("id,title,body,status,settings")
        .eq("user_id", input.userId)
        .eq("id", binding.socialPostId)
        .single();
      if (error || !post || (post.settings?.card && post.settings.card.cardId !== card.data.cardId))
        throw new Error(
          "A previously prepared routine draft is unavailable or has changed identity.",
        );
      recover(post, card.data);
    }
  }
  // Recover posts even if the process stopped before prepared_output was written. The
  // persisted card identity also preserves bindings created by the old positional scheme.
  const { data: savedPosts, error: recoveryError } = await db
    .from("social_posts")
    .select("id,title,body,status,settings")
    .eq("user_id", input.userId)
    .eq("settings->>routineRunId", input.runId)
    .eq("settings->>routineId", input.routineId);
  if (recoveryError) throw new Error("Saved routine drafts could not be recovered.");
  for (const row of savedPosts || []) recover(row);
  for (const card of drafts) {
    if (canonical.has(card.cardId)) continue;
    // Slot/card identity is stable even when neighboring slots yield ideas on a retry.
    const id = await routinePostId(input.runId, card.cardId);
    const { error } = await db.from("social_posts").upsert(
      {
        id,
        user_id: input.userId,
        title: card.title,
        body: card.body,
        status: "draft",
        timezone: input.timezone,
        media: [],
        settings: {
          routineRunId: input.runId,
          routineId: input.routineId,
          platform: card.platform,
          sourceUrls: card.sourceUrls,
          card,
          routineOutputReady: true,
          visualReadiness: card.platform === "instagram" ? "visuals_needed" : "not_required",
          ...(input.slots[
            input.result.cards.findIndex((candidate) => candidate.cardId === card.cardId)
          ]?.scheduledAt
            ? {
                routineSlotAt:
                  input.slots[
                    input.result.cards.findIndex((candidate) => candidate.cardId === card.cardId)
                  ].scheduledAt,
              }
            : {}),
        },
      },
      { onConflict: "id", ignoreDuplicates: true },
    );
    if (error) throw new Error("Routine draft could not be saved.");
    const { data: existing, error: readError } = await db
      .from("social_posts")
      .select("id,title,body,status,settings")
      .eq("user_id", input.userId)
      .eq("id", id)
      .single();
    if (readError || !existing) throw new Error("Routine draft could not be verified.");
    recover(existing);
  }
  const merged = new Map<string, ContentAgentResult["cards"][number]>();
  const previous = contentAgentResultSchema.safeParse(run.prepared_output?.result);
  if (previous.success)
    for (const card of previous.data.cards) if (card.type === "idea") merged.set(card.cardId, card);
  for (const card of input.result.cards) if (card.type === "idea") merged.set(card.cardId, card);
  // Canonical drafts win over a later fallback idea for the same slot, including slots
  // omitted by the retry. No creator edits/status are written back to social_posts.
  for (const binding of canonical.values()) merged.set(binding.card.cardId, binding.card);
  prepared.drafts = [...canonical.values()].sort((a, b) =>
    a.card.cardId.localeCompare(b.card.cardId, undefined, { numeric: true }),
  );
  prepared.result.cards = [...merged.values()].sort((a, b) =>
    a.cardId.localeCompare(b.cardId, undefined, { numeric: true }),
  );
  const { error } = await db
    .from("content_routine_runs")
    .update({ prepared_output: prepared })
    .eq("id", input.runId)
    .eq("user_id", input.userId)
    .eq("routine_id", input.routineId);
  if (error) throw new Error("Prepared routine batch could not be saved.");
  if (db === supabaseAdmin) {
    const { prepareAgentPost } = await import("./content-agent-preparation.server");
    for (const draft of prepared.drafts) await prepareAgentPost(input.userId, draft.socialPostId);
  }
  return prepared.drafts.length;
}
