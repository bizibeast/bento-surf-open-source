/* eslint-disable @typescript-eslint/no-explicit-any -- Agent payloads are validated before actions. */
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { storedContentAgentResultSchema } from "./content-agent-proactive";
import { carouselCopyIssues, carouselReady } from "./content-carousel";
import { resolveOwnedAgentMedia } from "./content-agent-media.server";
import { validatePostForProviders } from "./social-scheduler";
import { saveSocialPostForUser } from "./social-scheduler.functions";
import { recordContentEvent } from "./content-workspace-analytics.server";

const uuid = z.string().uuid();
export const agentCardActionSchema = z.object({
  messageId: uuid,
  cardId: z.string().min(1).max(100),
});
export const agentScheduleApprovalSchema = z.object({
  messageId: uuid,
  draftCardId: z.string().min(1).max(100),
  scheduleCardId: z.string().min(1).max(100),
  revision: z.number().int().nonnegative(),
});

export async function loadAssistantResult(userId: string, messageId: string) {
  const { data, error } = await (supabaseAdmin as any)
    .from("content_agent_messages")
    .select("id,thread_id,role,payload")
    .eq("id", messageId)
    .eq("user_id", userId)
    .eq("role", "assistant")
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error || !data) throw new Error("This Agent result is unavailable.");
  return {
    threadId: String(data.thread_id),
    result: storedContentAgentResultSchema.parse(data.payload),
  };
}

export async function approveAgentBrainProposalForUser(userId: string, input: unknown) {
  const data = agentCardActionSchema.parse(input);
  const { result } = await loadAssistantResult(userId, data.messageId);
  const card = result.cards.find(
    (candidate) => candidate.cardId === data.cardId && candidate.type === "brain_proposal",
  );
  if (!card || card.type !== "brain_proposal") {
    throw new Error("This Brain proposal is unavailable.");
  }
  const { data: inserted, error } = await (supabaseAdmin as any)
    .from("creator_brain_items")
    .insert({
      user_id: userId,
      kind: card.kind,
      title: card.title,
      content: card.content,
      provenance: "agent_chat",
      source_url: card.sourceUrl,
      source_ref: card.sourceRef || `agent:${data.messageId}:${card.cardId}`,
      status: "confirmed",
      locked: false,
    })
    .select("id")
    .single();
  if (error || !inserted) throw new Error("The Brain proposal could not be saved.");
  return { id: String(inserted.id) };
}

export async function approveAgentScheduleProposalForUser(userId: string, input: unknown) {
  const data = agentScheduleApprovalSchema.parse(input);
  const { result } = await loadAssistantResult(userId, data.messageId);
  const draft = result.cards.find(
    (candidate) => candidate.cardId === data.draftCardId && candidate.type === "draft",
  );
  const schedule = result.cards.find(
    (candidate) =>
      candidate.cardId === data.scheduleCardId && candidate.type === "schedule_proposal",
  );
  if (!draft || draft.type !== "draft" || !schedule || schedule.type !== "schedule_proposal") {
    throw new Error("This scheduling proposal is unavailable.");
  }
  if (schedule.draftCardId !== draft.cardId) throw new Error("The scheduling proposal changed.");
  const media = await resolveAgentDraftMedia(userId, result, draft.cardId, data.revision);
  const saved = await saveSocialPostForUser(
    userId,
    {
      body: draft.body,
      title: draft.title,
      scheduledAt: schedule.scheduledAt,
      timezone: schedule.timezone,
      connectionIds: [schedule.connectionId],
      media,
      providerSettings: {},
      publishNow: false,
      asDraft: false,
    },
    { messageId: data.messageId, cardId: draft.cardId, revision: data.revision },
  );
  void recordContentEvent(userId, "content_draft_approved", {
    platform: draft.platform,
    format: draft.format,
    sourceCount: draft.sourceUrls.length,
  });
  return saved;
}

export async function resolveAgentDraftMedia(
  userId: string,
  result: Awaited<ReturnType<typeof loadAssistantResult>>["result"],
  cardId: string,
  revision: number,
  requirePhoto = true,
) {
  const card = result.cards.find((c) => c.type === "draft" && c.cardId === cardId);
  if (!card || card.type !== "draft") throw new Error("This draft is unavailable.");
  const state = result.draftStates?.[cardId];
  if ((state?.revision || 0) !== revision) throw new Error("Draft changed. Reload and retry.");
  if (
    card.platform === "instagram" &&
    (card.format !== "carousel" || !carouselReady(card.slides || [], state))
  )
    throw new Error("Copy ready, visuals needed. Export every slide first.");
  const media = await resolveOwnedAgentMedia(userId, state?.mediaIds || card.mediaIds || []);
  if (
    requirePhoto &&
    (card.platform === "linkedin" || state?.photoRequired) &&
    !media.some((asset) => /^image\//.test(asset.mimeType))
  )
    throw new Error("Add a photo before reviewing this post for publishing.");
  // Explicit approvals validate against the destination account in the scheduler service.
  // Keep this shared boundary limited to revision, readiness and owned media resolution.
  return media;
}
export async function mutateAgentDraft(
  userId: string,
  input: { messageId: string; cardId: string; revision: number },
  operation: "edit" | "attach" | "handoff" | "background",
  patch: Record<string, unknown> = {},
) {
  const { result } = await loadAssistantResult(userId, input.messageId);
  const card = result.cards.find((c) => c.type === "draft" && c.cardId === input.cardId);
  if (!card || card.type !== "draft") throw new Error("This draft is unavailable.");
  if ((result.draftStates?.[card.cardId]?.revision || 0) !== input.revision)
    throw new Error("Draft changed. Reload and retry.");
  if (patch.slides) {
    const issues = carouselCopyIssues(patch.slides as NonNullable<typeof card.slides>);
    if (issues.length) throw new Error(issues[0]);
  }
  let resultingSlides = (patch.slides || card.slides || []) as NonNullable<typeof card.slides>;
  if (operation === "background" && card.format === "carousel") {
    const index = Number(patch.slideIndex ?? 0);
    const ids = patch.mediaIds as string[];
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= resultingSlides.length ||
      ids?.length !== 1
    )
      throw new Error("Choose one owned image for an existing slide.");
    resultingSlides = resultingSlides.map((slide, i) =>
      i === index ? { ...slide, mediaId: ids[0] } : slide,
    );
  }
  // Validate only references that the mutation leaves on the draft; a deleted target can be repaired.
  const backgroundIds = [
    ...new Set(resultingSlides.flatMap((s) => (s.mediaId ? [s.mediaId] : []))),
  ];
  if (backgroundIds.length) await resolveOwnedAgentMedia(userId, backgroundIds);
  if (operation === "attach") {
    const issues = carouselCopyIssues(card.slides || []);
    if (issues.length) throw new Error(issues[0]);
  }
  const media =
    operation === "handoff"
      ? await resolveAgentDraftMedia(userId, result, card.cardId, input.revision, false)
      : operation === "attach" || operation === "background"
        ? await resolveOwnedAgentMedia(userId, patch.mediaIds as string[])
        : [];
  if (operation === "attach" || operation === "handoff") {
    // Handoff only opens a draft; X account capabilities are checked after account selection.
    const errors = validatePostForProviders(
      card.body,
      media,
      [card.platform],
      card.title,
      {},
      undefined,
      false,
      operation === "handoff" ? "draft_handoff" : "publish",
    );
    if (Object.keys(errors).length) throw new Error(Object.values(errors)[0]);
  }
  const { data, error } = await (supabaseAdmin as any).rpc("mutate_content_agent_draft", {
    p_user_id: userId,
    p_message_id: input.messageId,
    p_card_id: input.cardId,
    p_revision: input.revision,
    p_operation: operation,
    p_patch: patch,
    p_media: media,
  });
  if (error || !data) throw new Error(error?.message || "Draft changed. Reload and retry.");
  if (operation === "edit" || operation === "background") {
    const { prepareAgentMessage } = await import("./content-agent-preparation.server");
    const prepared = await prepareAgentMessage(userId, input.messageId, input.cardId);
    return prepared.draftStates?.[input.cardId] || data;
  }
  return data as import("./content-carousel").AgentDraftState;
}
