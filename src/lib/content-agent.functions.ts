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
} from "./content-agent.actions";
import { runContentAgentTurn } from "./content-agent.server";
import { requestContentIndex } from "./content-index.server";
import { enforceRequestRateLimit } from "./request-security.server";
import { recordContentEvent } from "./content-workspace-analytics.server";

const uuid = z.string().uuid();
const sendMessageSchema = z.object({
  threadId: uuid.nullable().optional(),
  text: z.string().trim().min(1).max(20_000),
});
const cardActionSchema = agentCardActionSchema;
const rejectDraftSchema = cardActionSchema.extend({ reason: z.string().trim().min(1).max(1_000) });
const scheduleApprovalSchema = agentScheduleApprovalSchema;

export const listContentAgentThreads = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireContentWorkspace(context.userId);
    const { data, error } = await (supabaseAdmin as any)
      .from("content_agent_threads")
      .select("id,title,last_message_at,created_at")
      .eq("user_id", context.userId)
      .order("last_message_at", { ascending: false })
      .limit(50);
    if (error) throw new Error("Agent conversations could not be loaded.");
    return data || [];
  });

export const getContentAgentThread = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ threadId: uuid }).parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const db = supabaseAdmin as any;
    const [thread, messages] = await Promise.all([
      db
        .from("content_agent_threads")
        .select("id,title,last_message_at,created_at")
        .eq("id", data.threadId)
        .eq("user_id", context.userId)
        .maybeSingle(),
      db
        .from("content_agent_messages")
        .select("id,role,content,payload,created_at")
        .eq("thread_id", data.threadId)
        .eq("user_id", context.userId)
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: true })
        .limit(100),
    ]);
    if (thread.error || !thread.data || messages.error) {
      throw new Error("This Agent conversation is unavailable.");
    }
    return { thread: thread.data, messages: messages.data || [] };
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
    return result;
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
    return runContentAgentTurn({
      userId: context.userId,
      threadId,
      text: `Regenerate the ${draft.platform} ${draft.format}. Keep the source facts. Feedback: ${data.reason}`,
    });
  });

export const saveAgentDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    cardActionSchema.extend({ body: z.string().trim().min(1).max(10_000) }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const { result } = await loadAssistantResult(context.userId, data.messageId);
    const draft = result.cards.find((card) => card.cardId === data.cardId && card.type === "draft");
    if (!draft || draft.type !== "draft") throw new Error("This draft is unavailable.");
    draft.body = data.body;
    const { data: saved, error } = await (supabaseAdmin as any)
      .from("content_agent_messages")
      .update({ payload: result })
      .eq("id", data.messageId)
      .eq("user_id", context.userId)
      .eq("role", "assistant")
      .select("id")
      .maybeSingle();
    if (error || !saved) throw new Error("Draft changes could not be saved.");
    return { id: saved.id };
  });

export const approveAgentScheduleProposal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => scheduleApprovalSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    return approveAgentScheduleProposalForUser(context.userId, data);
  });
