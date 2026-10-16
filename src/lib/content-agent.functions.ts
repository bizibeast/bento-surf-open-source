/* eslint-disable @typescript-eslint/no-explicit-any -- Agent rows are validated before use. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireContentWorkspace } from "./content-access.server";
import {
  agentCardActionSchema,
  agentScheduleApprovalSchema,
  approveAgentBrainProposalForUser,
  approveAgentScheduleProposalForUser,
  loadAssistantResult,
  mutateAgentDraft,
} from "./content-agent.actions";
import { runContentAgentTurn } from "./content-agent.server";
import { requestContentIndex } from "./content-index.server";
import { enforceRequestRateLimit } from "./request-security.server";
import { recordContentEvent } from "./content-workspace-analytics.server";

import {
  listContentAgentThreadsForWorkspace,
  type ContentAgentThread,
} from "./content-agent-identity.server";

import { carouselSlideSchema } from "./content-editorial";
import { registerAgentMedia } from "./content-agent-media.server";
const uuid = z.string().uuid();
const sendMessageSchema = z.object({
  threadId: uuid.nullable().optional(),
  text: z.string().trim().min(1).max(20_000),
});
const cardActionSchema = agentCardActionSchema;
const rejectDraftSchema = cardActionSchema.extend({ reason: z.string().trim().min(1).max(1_000) });
const scheduleApprovalSchema = agentScheduleApprovalSchema;

const threadCursorSchema = z.object({
  pinnedAt: z.string().datetime({ offset: true }).nullable(),
  lastMessageAt: z.string().datetime({ offset: true }),
  id: uuid,
});

export const listContentAgentThreads = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireContentWorkspace(context.userId);
    const page = await listContentAgentThreadsForWorkspace(context.userId);
    return [page.agent, ...page.chats];
  });

export const listContentAgentThreadsPage = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        cursor: threadCursorSchema.nullable().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    return listContentAgentThreadsForWorkspace(context.userId, data);
  });

async function setThreadState(
  workspaceId: string,
  threadId: string,
  patch: { p_pinned?: boolean; p_mark_read?: boolean; p_through_message_id?: string },
): Promise<ContentAgentThread> {
  const { data, error } = await (supabaseAdmin as any).rpc("set_content_agent_thread_state", {
    p_user_id: workspaceId,
    p_thread_id: threadId,
    ...patch,
  });
  if (error || !data) throw new Error("This Agent conversation is unavailable.");
  return data;
}

export const setContentAgentThreadPinned = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ threadId: uuid, pinned: z.boolean() }).parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    return setThreadState(context.userId, data.threadId, { p_pinned: data.pinned });
  });

export const renameContentAgentChat = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z.object({ threadId: uuid, title: z.string().trim().min(1).max(160) }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const { data: chat, error } = await (supabaseAdmin as any)
      .from("content_agent_threads")
      .update({ title: data.title })
      .eq("id", data.threadId)
      .eq("user_id", context.userId)
      .eq("kind", "chat")
      .select("id,title")
      .maybeSingle();
    if (error || !chat) throw new Error("This chat is unavailable.");
    return chat as { id: string; title: string };
  });

export const deleteContentAgentChat = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ threadId: uuid }).parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const { data: chat, error } = await (supabaseAdmin as any)
      .from("content_agent_threads")
      .delete()
      .eq("id", data.threadId)
      .eq("user_id", context.userId)
      .eq("kind", "chat")
      .select("id")
      .maybeSingle();
    if (error || !chat) throw new Error("This chat is unavailable.");
    return { id: chat.id as string };
  });

export const markContentAgentThreadRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z.object({ threadId: uuid, throughMessageId: uuid.optional() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    return setThreadState(context.userId, data.threadId, {
      p_mark_read: true,
      ...(data.throughMessageId ? { p_through_message_id: data.throughMessageId } : {}),
    });
  });

export const getContentAgentThread = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({ threadId: uuid, knownRevision: z.number().int().nonnegative().optional() })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const db = supabaseAdmin as any;
    const thread = await db
      .from("content_agent_threads")
      .select(
        "id,user_id,title,kind,pinned_at,last_read_at,last_message_at,created_at,updated_at,content_revision",
      )
      .eq("id", data.threadId)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (thread.error || !thread.data) throw new Error("This Agent conversation is unavailable.");
    if (data.knownRevision !== undefined && data.knownRevision === thread.data.content_revision)
      return { thread: thread.data, messages: [] as any[], unchanged: true };
    const messages = await db
      .from("content_agent_messages")
      .select("id,role,content,payload,created_at")
      .eq("thread_id", data.threadId)
      .eq("user_id", context.userId)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(100);
    if (messages.error) throw new Error("This Agent conversation is unavailable.");
    return { thread: thread.data, messages: (messages.data || []).reverse(), unchanged: false };
  });

export const sendContentAgentMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => sendMessageSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "content-agent-turn",
      context.userId,
    );
    const result = await runContentAgentTurn({
      userId: context.userId,
      threadId: data.threadId,
      text: data.text,
    });
    void recordContentEvent(context.userId, "content_agent_turn", {
      action: result.result.action,
      cardCount: result.result.cards.length,
    });
    return {
      ...result,
      result: (await loadAssistantResult(context.userId, result.messageId)).result,
    };
  });

export const prepareContentAgentDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => agentCardActionSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "agent-prepare-visuals",
      context.userId,
    );
    const { prepareAgentMessage } = await import("./content-agent-preparation.server");
    return prepareAgentMessage(context.userId, data.messageId, data.cardId);
  });

export const generateInitialBrainSuggestions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireContentWorkspace(context.userId);
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "content-brain-inference",
      context.userId,
    );
    return requestContentIndex(context.userId, true);
  });

export const approveAgentBrainProposal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => cardActionSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    return approveAgentBrainProposalForUser(context.userId, data);
  });

export const rejectAgentDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => rejectDraftSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const { threadId, result } = await loadAssistantResult(context.userId, data.messageId);
    const draft = result.cards.find(
      (candidate) => candidate.cardId === data.cardId && candidate.type === "draft",
    );
    if (!draft) throw new Error("This draft is unavailable.");
    const { error } = await (supabaseAdmin as any).from("content_agent_messages").insert({
      user_id: context.userId,
      thread_id: threadId,
      role: "system_event",
      content: "Draft rejected.",
      payload: {
        feedback: {
          type: "rejected",
          messageId: data.messageId,
          cardId: data.cardId,
          reason: data.reason,
        },
      },
    });
    if (error) throw new Error("Draft feedback could not be saved.");
    void recordContentEvent(context.userId, "content_draft_rejected", {
      platform: draft.type === "draft" ? draft.platform : undefined,
      reasonLength: data.reason.length,
    });
    void recordContentEvent(context.userId, "content_agent_draft_review", {
      status: "rejected",
      count: 1,
    });
    return { rejected: true };
  });

export const regenerateAgentDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => rejectDraftSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "content-agent-turn",
      context.userId,
    );
    const { threadId, result } = await loadAssistantResult(context.userId, data.messageId);
    const draft = result.cards.find(
      (candidate) => candidate.cardId === data.cardId && candidate.type === "draft",
    );
    if (!draft || draft.type !== "draft") throw new Error("This draft is unavailable.");
    const regenerated = await runContentAgentTurn({
      userId: context.userId,
      threadId,
      text: `Regenerate the ${draft.platform} ${draft.format}. Keep the source facts. Feedback: ${data.reason}`,
      revision: { messageId: data.messageId, cardId: data.cardId },
    });
    return {
      ...regenerated,
      result: (await loadAssistantResult(context.userId, regenerated.messageId)).result,
    };
  });

const revisedDraftSchema = cardActionSchema.extend({ revision: z.number().int().nonnegative() });
export const saveAgentDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    revisedDraftSchema
      .extend({
        body: z.string().trim().min(1).max(10000),
        slides: z.array(carouselSlideSchema).min(2).max(10).optional(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const result = await mutateAgentDraft(context.userId, data, "edit", {
      body: data.body,
      ...(data.slides ? { slides: data.slides } : {}),
    });
    void recordContentEvent(context.userId, "content_agent_draft_review", {
      status: "edited",
      count: 1,
    });
    return result;
  });
export const registerAgentExport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    revisedDraftSchema
      .extend({ key: z.string().min(1).max(1000), slideIndex: z.number().int().min(0).max(9) })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const { result } = await loadAssistantResult(context.userId, data.messageId);
    if (
      !result.cards.some((c) => c.cardId === data.cardId && c.type === "draft") ||
      (result.draftStates?.[data.cardId]?.revision || 0) !== data.revision
    )
      throw new Error("Draft changed. Reload and retry.");
    return { id: await registerAgentMedia(context.userId, data.key, "carousel_export", data) };
  });
export const attachAgentExport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    revisedDraftSchema.extend({ mediaIds: z.array(uuid).min(2).max(10) }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    return mutateAgentDraft(context.userId, data, "attach", { mediaIds: data.mediaIds });
  });
export const handoffAgentDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => revisedDraftSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const saved = await loadAssistantResult(context.userId, data.messageId);
    if ((saved.result.draftStates?.[data.cardId]?.revision || 0) !== data.revision)
      throw new Error("Draft changed. Reload and retry.");
    let revision = data.revision;
    if (!saved.result.draftStates?.[data.cardId]?.preparation) {
      const { prepareAgentMessage } = await import("./content-agent-preparation.server");
      const prepared = await prepareAgentMessage(context.userId, data.messageId, data.cardId);
      revision = prepared.draftStates?.[data.cardId]?.revision || revision;
    }
    const result = await mutateAgentDraft(context.userId, { ...data, revision }, "handoff");
    void recordContentEvent(context.userId, "content_agent_draft_review", {
      status: "handoff",
      count: 1,
    });
    return result;
  });

export const approveAgentScheduleProposal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => scheduleApprovalSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    return approveAgentScheduleProposalForUser(context.userId, data);
  });

export const giveContentAgentFeedback = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({ messageId: uuid, feedback: z.enum(["useful", "not_relevant", "less_like_this"]) })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId, "contentAgent");
    const { data: saved, error } = await (supabaseAdmin as any).rpc(
      "feedback_content_agent_signal",
      {
        p_user_id: context.userId,
        p_message_id: data.messageId,
        p_feedback: data.feedback,
      },
    );
    if (error || !saved) throw new Error("This Agent message is unavailable.");
    void recordContentEvent(context.userId, "content_agent_dismissal", {
      action: data.feedback,
      count: 1,
    });
    return { saved: true };
  });
