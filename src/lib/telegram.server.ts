/* eslint-disable @typescript-eslint/no-explicit-any -- Telegram rows are validated at boundaries. */
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  agentCardActionSchema,
  agentScheduleApprovalSchema,
  approveAgentBrainProposalForUser,
  approveAgentScheduleProposalForUser,
} from "./content-agent.actions";
import { runContentAgentTurn } from "./content-agent.server";
import { requireContentWorkspace } from "./content-access.server";
import { enforceRequestRateLimit, readRequestText } from "./request-security.server";
import {
  parseTelegramUpdate,
  renderTelegramAgentResult,
  telegramActionId,
  telegramStartState,
  type TelegramUpdate,
} from "./telegram";

const usernamePattern = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const webhookSecretPattern = /^[A-Za-z0-9_-]{16,256}$/;

function configuredValue(name: string) {
  return process.env[name]?.trim() || "";
}

export function telegramConfiguration() {
  const token = configuredValue("TELEGRAM_BOT_TOKEN");
  const username = configuredValue("TELEGRAM_BOT_USERNAME").replace(/^@/, "");
  const webhookSecret = configuredValue("TELEGRAM_WEBHOOK_SECRET");
  if (!token || !usernamePattern.test(username) || !webhookSecretPattern.test(webhookSecret)) {
    throw new Error("Telegram is awaiting Bento's secure bot configuration.");
  }
  return { token, username, webhookSecret };
}

export function telegramReady() {
  try {
    telegramConfiguration();
    return true;
  } catch {
    return false;
  }
}

export function telegramBotUsername() {
  try {
    return telegramConfiguration().username;
  } catch {
    return null;
  }
}

export function telegramDeepLink(state: string) {
  const { username } = telegramConfiguration();
  return `https://t.me/${username}?start=${encodeURIComponent(state)}`;
}

export type TelegramQueueMessage = { kind: "telegram_update"; updateId: number };
type TelegramQueue = { send(message: TelegramQueueMessage): Promise<unknown> };

type TelegramConnection = {
  id: string;
  userId: string;
  chatId: string;
  displayName: string | null;
  metadata: Record<string, unknown>;
};

type TelegramReceipt = { update_id: number; payload: unknown; attempts: number };
type TelegramAction = {
  id: string;
  user_id: string;
  action_type: "approve_schedule" | "approve_brain";
  payload: unknown;
};

export type TelegramServerDependencies = {
  claimUpdate(updateId: number): Promise<TelegramReceipt | null>;
  finishUpdate(updateId: number, status: "processed" | "failed", error?: string): Promise<void>;
  consumeState(state: string): Promise<{ userId: string } | null>;
  bindConnection(input: {
    userId: string;
    chatId: string;
    displayName: string | null;
    username: string | null;
  }): Promise<TelegramConnection>;
  findConnection(chatId: string): Promise<TelegramConnection | null>;
  saveThreadId(connection: TelegramConnection, threadId: string): Promise<void>;
  requireContent(userId: string): Promise<unknown>;
  rateLimit(userId: string): Promise<void>;
  runAgent(input: {
    userId: string;
    threadId?: string | null;
    text: string;
  }): ReturnType<typeof runContentAgentTurn>;
  createActions(input: {
    connection: TelegramConnection;
    messageId: string;
    result: Awaited<ReturnType<typeof runContentAgentTurn>>["result"];
  }): Promise<Array<{ id: string; label: string }>>;
  claimAction(actionId: string, chatId: string): Promise<TelegramAction | null>;
  approveSchedule(userId: string, payload: unknown): Promise<unknown>;
  approveBrain(userId: string, payload: unknown): Promise<unknown>;
  sendText(
    chatId: string,
    text: string,
    actions?: Array<{ id: string; label: string }>,
  ): Promise<void>;
  answerCallback(callbackId: string, text: string, alert?: boolean): Promise<void>;
};

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : "Telegram processing failed.").slice(0, 1_000);
}

function constantTimeEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

async function telegramApi(method: string, body: Record<string, unknown>) {
  const { token } = telegramConfiguration();
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await response.json().catch(() => null)) as { ok?: boolean } | null;
  if (!response.ok || payload?.ok !== true) throw new Error("Telegram rejected Bento's request.");
}

export async function sendTelegramText(
  chatId: string,
  text: string,
  actions: Array<{ id: string; label: string }> = [],
) {
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    ...(actions.length
      ? {
          reply_markup: {
            inline_keyboard: actions.map((action) => [
              { text: action.label.slice(0, 64), callback_data: `tg:${action.id}` },
            ]),
          },
        }
      : {}),
  });
}

export async function sendTelegramDraftsReady(input: {
  userId: string;
  runId: string;
  draftCount: number;
  platforms: string[];
}) {
  const { data, error } = await (supabaseAdmin as any)
    .from("content_connections")
    .select("external_account_id")
    .eq("user_id", input.userId)
    .eq("provider", "telegram")
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("Telegram connection could not be loaded.");
  if (!data) return null;
  const count = Math.max(0, Math.trunc(input.draftCount));
  if (!count) return null;
  const platforms = [...new Set(input.platforms.map((value) => value.trim()).filter(Boolean))]
    .slice(0, 8)
    .join(", ");
  const appUrl = (process.env.VITE_APP_URL?.trim() || "http://localhost:8080").replace(/\/$/, "");
  await sendTelegramText(
    String(data.external_account_id),
    `Your posts are ready.\nBento prepared ${count} drafts${platforms ? ` for ${platforms}` : ""}. Review and approve them before scheduling.\n${appUrl}/content?tab=agent`,
  );
  return { sent: true as const, runId: input.runId };
}

async function answerTelegramCallback(callbackId: string, text: string, alert = false) {
  await telegramApi("answerCallbackQuery", {
    callback_query_id: callbackId,
    text: text.slice(0, 200),
    show_alert: alert,
  });
}

function displayName(update: TelegramUpdate) {
  const sender = update.message?.from || update.callback_query?.from;
  if (!sender) return null;
  if (sender.username) return `@${sender.username}`;
  return [sender.first_name, sender.last_name].filter(Boolean).join(" ").slice(0, 160) || null;
}

async function createTelegramActions(input: {
  connection: TelegramConnection;
  messageId: string;
  result: Awaited<ReturnType<typeof runContentAgentTurn>>["result"];
}) {
  const rows: Array<Record<string, unknown>> = [];
  for (const card of input.result.cards) {
    if (card.type === "brain_proposal") {
      rows.push({
        user_id: input.connection.userId,
        connection_id: input.connection.id,
        action_type: "approve_brain",
        payload: { messageId: input.messageId, cardId: card.cardId },
      });
    }
    if (card.type === "schedule_proposal") {
      rows.push({
        user_id: input.connection.userId,
        connection_id: input.connection.id,
        action_type: "approve_schedule",
        payload: {
          messageId: input.messageId,
          draftCardId: card.draftCardId,
          scheduleCardId: card.cardId,
        },
      });
    }
  }
  if (!rows.length) return [];
  const { data, error } = await (supabaseAdmin as any)
    .from("telegram_actions")
    .insert(rows)
    .select("id,action_type");
  if (error) throw new Error("Telegram actions could not be prepared.");
  return (data || []).map((row: any) => ({
    id: String(row.id),
    label: row.action_type === "approve_schedule" ? "Approve scheduling" : "Save to Brain",
  }));
}

const defaultDependencies: TelegramServerDependencies = {
  async claimUpdate(updateId) {
    const { data, error } = await (supabaseAdmin as any).rpc("claim_telegram_update", {
      p_update_id: updateId,
    });
    if (error) throw new Error("Telegram update could not be claimed.");
    return (data || [])[0] || null;
  },
  async finishUpdate(updateId, status, error) {
    const result = await (supabaseAdmin as any).rpc("finish_telegram_update", {
      p_update_id: updateId,
      p_status: status,
      p_error_message: error || null,
    });
    if (result.error) throw new Error("Telegram update could not be completed.");
  },
  async consumeState(state) {
    const { data, error } = await (supabaseAdmin as any)
      .from("content_connection_states")
      .delete()
      .eq("state", state)
      .eq("provider", "telegram")
      .gt("expires_at", new Date().toISOString())
      .select("user_id")
      .maybeSingle();
    if (error) throw new Error("Telegram connection state could not be consumed.");
    return data ? { userId: String(data.user_id) } : null;
  },
  async bindConnection(input) {
    const db = supabaseAdmin as any;
    const { data: occupied, error: occupiedError } = await db
      .from("content_connections")
      .select("id,user_id")
      .eq("provider", "telegram")
      .eq("external_account_id", input.chatId)
      .maybeSingle();
    if (occupiedError || (occupied && occupied.user_id !== input.userId)) {
      throw new Error("This Telegram chat is already connected.");
    }
    await db
      .from("content_connections")
      .delete()
      .eq("user_id", input.userId)
      .eq("provider", "telegram")
      .neq("external_account_id", input.chatId);
    const { data, error } = await db
      .from("content_connections")
      .upsert(
        {
          user_id: input.userId,
          provider: "telegram",
          external_account_id: input.chatId,
          display_name: input.displayName,
          status: "active",
          scopes: ["private_chat"],
          metadata: { username: input.username },
          last_error: null,
        },
        { onConflict: "user_id,provider,external_account_id" },
      )
      .select("id,user_id,external_account_id,display_name,metadata")
      .single();
    if (error || !data) throw new Error("Telegram connection could not be saved.");
    return {
      id: String(data.id),
      userId: String(data.user_id),
      chatId: String(data.external_account_id),
      displayName: (data.display_name as string | null) || null,
      metadata: (data.metadata || {}) as Record<string, unknown>,
    };
  },
  async findConnection(chatId) {
    const { data, error } = await (supabaseAdmin as any)
      .from("content_connections")
      .select("id,user_id,external_account_id,display_name,metadata")
      .eq("provider", "telegram")
      .eq("external_account_id", chatId)
      .eq("status", "active")
      .maybeSingle();
    if (error) throw new Error("Telegram connection could not be loaded.");
    return data
      ? {
          id: String(data.id),
          userId: String(data.user_id),
          chatId: String(data.external_account_id),
          displayName: (data.display_name as string | null) || null,
          metadata: (data.metadata || {}) as Record<string, unknown>,
        }
      : null;
  },
  async saveThreadId(connection, threadId) {
    const { error } = await (supabaseAdmin as any)
      .from("content_connections")
      .update({ metadata: { ...connection.metadata, threadId } })
      .eq("id", connection.id)
      .eq("user_id", connection.userId)
      .eq("provider", "telegram");
    if (error) throw new Error("Telegram Agent thread could not be saved.");
  },
  requireContent: requireContentWorkspace,
  rateLimit(userId) {
    return enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "content-agent-turn", userId);
  },
  runAgent: runContentAgentTurn,
  createActions: createTelegramActions,
  async claimAction(actionId, chatId) {
    const { data, error } = await (supabaseAdmin as any).rpc("claim_telegram_action", {
      p_action_id: actionId,
      p_chat_id: chatId,
    });
    if (error) throw new Error("Telegram action could not be claimed.");
    return (data || [])[0] || null;
  },
  approveSchedule: approveAgentScheduleProposalForUser,
  approveBrain: approveAgentBrainProposalForUser,
  sendText: sendTelegramText,
  answerCallback: answerTelegramCallback,
};

function threadIdFrom(connection: TelegramConnection) {
  return z.string().uuid().safeParse(connection.metadata.threadId).data || null;
}

async function processMessage(
  update: TelegramUpdate & { message: NonNullable<TelegramUpdate["message"]> },
  dependencies: TelegramServerDependencies,
) {
  const chatId = String(update.message.chat.id);
  const state = telegramStartState(update.message.text);
  if (state) {
    const connectionOwner = await dependencies.consumeState(state);
    if (!connectionOwner) {
      await dependencies.sendText(
        chatId,
        "This Bento connection link expired. Create a new one in Settings → Integrations.",
      );
      return;
    }
    await dependencies.requireContent(connectionOwner.userId);
    await dependencies.bindConnection({
      userId: connectionOwner.userId,
      chatId,
      displayName: displayName(update),
      username: update.message.from?.username || update.message.chat.username || null,
    });
    await dependencies.sendText(chatId, "Telegram is connected to your Bento Content Agent.");
    return;
  }

  const connection = await dependencies.findConnection(chatId);
  if (!connection) {
    await dependencies.sendText(
      chatId,
      "Connect Telegram from Bento Settings → Integrations first.",
    );
    return;
  }
  await dependencies.requireContent(connection.userId);
  await dependencies.rateLimit(connection.userId);
  const turn = await dependencies.runAgent({
    userId: connection.userId,
    threadId: threadIdFrom(connection),
    text: update.message.text,
  });
  await dependencies.saveThreadId(connection, turn.threadId);
  const actions = await dependencies.createActions({
    connection,
    messageId: turn.messageId,
    result: turn.result,
  });
  const chunks = renderTelegramAgentResult(turn.result);
  for (let index = 0; index < chunks.length; index += 1) {
    await dependencies.sendText(
      chatId,
      chunks[index],
      index === chunks.length - 1 ? actions : undefined,
    );
  }
}

async function processCallback(
  update: TelegramUpdate & { callback_query: NonNullable<TelegramUpdate["callback_query"]> },
  dependencies: TelegramServerDependencies,
) {
  const callback = update.callback_query;
  const chatId = String(callback.message.chat.id);
  const actionId = telegramActionId(callback.data);
  if (!actionId) {
    await dependencies.answerCallback(callback.id, "This action is invalid.", true);
    return;
  }
  const action = await dependencies.claimAction(actionId, chatId);
  if (!action) {
    await dependencies.answerCallback(
      callback.id,
      "This action expired or was already used.",
      true,
    );
    return;
  }
  await dependencies.requireContent(action.user_id);
  if (action.action_type === "approve_schedule") {
    const payload = agentScheduleApprovalSchema.parse(action.payload);
    await dependencies.approveSchedule(action.user_id, payload);
    await dependencies.answerCallback(callback.id, "Scheduled.");
    await dependencies.sendText(chatId, "Approved and added to your Bento scheduler.");
    return;
  }
  const payload = agentCardActionSchema.parse(action.payload);
  await dependencies.approveBrain(action.user_id, payload);
  await dependencies.answerCallback(callback.id, "Saved to Brain.");
  await dependencies.sendText(chatId, "Approved and saved to your Bento Brain.");
}

export async function processTelegramQueueMessage(
  message: TelegramQueueMessage,
  dependencies: TelegramServerDependencies = defaultDependencies,
) {
  const receipt = await dependencies.claimUpdate(message.updateId);
  if (!receipt) return;
  try {
    const update = parseTelegramUpdate(receipt.payload);
    if (update.message) {
      await processMessage(
        update as TelegramUpdate & { message: NonNullable<TelegramUpdate["message"]> },
        dependencies,
      );
    } else if (update.callback_query) {
      await processCallback(
        update as TelegramUpdate & {
          callback_query: NonNullable<TelegramUpdate["callback_query"]>;
        },
        dependencies,
      );
    }
    await dependencies.finishUpdate(message.updateId, "processed");
  } catch (error) {
    await dependencies.finishUpdate(message.updateId, "failed", safeError(error));
    throw error;
  }
}

export async function handleTelegramWebhook(request: Request, queue?: TelegramQueue) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let secret: string;
  try {
    secret = telegramConfiguration().webhookSecret;
  } catch {
    return new Response("Unavailable", { status: 503 });
  }
  const received = request.headers.get("x-telegram-bot-api-secret-token") || "";
  if (!constantTimeEqual(secret, received)) return new Response("Unauthorized", { status: 401 });
  if (!queue) return new Response("Unavailable", { status: 503 });

  let update: TelegramUpdate;
  try {
    update = parseTelegramUpdate(JSON.parse(await readRequestText(request, 64 * 1024)));
  } catch {
    return new Response("Invalid update", { status: 400 });
  }
  const db = supabaseAdmin as any;
  const { error } = await db.from("telegram_update_receipts").insert({
    update_id: update.update_id,
    payload: update,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
  });
  if (error?.code === "23505") return new Response("OK");
  if (error) return new Response("Unavailable", { status: 503 });
  try {
    await queue.send({ kind: "telegram_update", updateId: update.update_id });
  } catch {
    await db.from("telegram_update_receipts").delete().eq("update_id", update.update_id);
    return new Response("Unavailable", { status: 503 });
  }
  return new Response("OK");
}

export async function cleanupTelegramReceipts() {
  const db = supabaseAdmin as any;
  const { data, error } = await db
    .from("telegram_update_receipts")
    .select("update_id")
    .lte("expires_at", new Date().toISOString())
    .limit(500);
  if (error) throw new Error("Telegram receipts could not be cleaned up.");
  const ids = (data || []).map((row: any) => row.update_id);
  if (ids.length) await db.from("telegram_update_receipts").delete().in("update_id", ids);
  return ids.length;
}
