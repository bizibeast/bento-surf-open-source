/* eslint-disable @typescript-eslint/no-explicit-any -- Agent payloads are validated before actions. */
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { contentAgentResultSchema } from "./content-agent";
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
});

export async function loadAssistantResult(userId: string, messageId: string) {
  const { data, error } = await (supabaseAdmin as any)
    .from("content_agent_messages")
    .select("id,thread_id,role,payload")
    .eq("id", messageId)
    .eq("user_id", userId)
    .eq("role", "assistant")
    .maybeSingle();
  if (error || !data) throw new Error("This Agent result is unavailable.");
  return { threadId: String(data.thread_id), result: contentAgentResultSchema.parse(data.payload) };
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
  const mediaIds = [...new Set(draft.mediaIds || [])];
  let media: Array<{ key: string; url: string; name: string; mimeType: string; size: number }> = [];
  if (mediaIds.length) {
    const { data: assets, error } = await (supabaseAdmin as any)
      .from("creator_content_media")
      .select("id,storage_key,public_url,mime_type,byte_size,caption")
      .eq("user_id", userId)
      .eq("status", "ready")
      .in("id", mediaIds);
    if (error || assets?.length !== mediaIds.length)
      throw new Error("The reviewed media is no longer available in your library.");
    media = mediaIds.map((id) => {
      const asset = assets.find((item: any) => item.id === id);
      return {
        key: asset.storage_key,
        url: asset.public_url,
        name: asset.caption?.slice(0, 160) || "Connected post media",
        mimeType: asset.mime_type,
        size: Number(asset.byte_size),
      };
    });
  }
  const saved = await saveSocialPostForUser(userId, {
    body: draft.body,
    title: draft.title,
    scheduledAt: schedule.scheduledAt,
    timezone: schedule.timezone,
    connectionIds: [schedule.connectionId],
    media,
    providerSettings: {},
    publishNow: false,
    asDraft: false,
  });
  void recordContentEvent(userId, "content_draft_approved", {
    platform: draft.platform,
    format: draft.format,
    sourceCount: draft.sourceUrls.length,
  });
  return saved;
}
