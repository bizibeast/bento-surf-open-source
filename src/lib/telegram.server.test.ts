import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramServerDependencies } from "./telegram.server";

const ids = {
  action: "44444444-4444-4444-8444-444444444444",
  message: "22222222-2222-4222-8222-222222222222",
  connection: "33333333-3333-4333-8333-333333333333",
};
const startUpdate = {
  update_id: 42,
  message: {
    message_id: 7,
    chat: { id: 99, type: "private", username: "creator" },
    from: { id: 99, username: "creator" },
    text: "/start 11111111-1111-4111-8111-111111111111",
  },
};
const textUpdate = {
  update_id: 43,
  message: {
    message_id: 8,
    chat: { id: 99, type: "private", username: "creator" },
    from: { id: 99, username: "creator" },
    text: "Plan today's posts",
  },
};
const callbackUpdate = {
  update_id: 44,
  callback_query: {
    id: "callback-1",
    from: { id: 99, username: "creator" },
    message: { message_id: 9, chat: { id: 99, type: "private" } },
    data: `tg:${ids.action}`,
  },
};

const mocks = vi.hoisted(() => ({
  receiptInsert: vi.fn(),
  receiptDelete: vi.fn(),
}));

function queryFor(table: string) {
  const query: Record<string, unknown> = {};
  for (const method of ["eq", "in", "limit", "lte", "select"] as const) {
    query[method] = vi.fn(() => query);
  }
  query.insert = vi.fn((value: unknown) => {
    mocks.receiptInsert(table, value);
    return mocks.receiptInsert.mock.results.at(-1)?.value || Promise.resolve({ error: null });
  });
  query.delete = vi.fn(() => {
    mocks.receiptDelete(table);
    return query;
  });
  query.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null }).then(resolve);
  return query;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (table: string) => queryFor(table), rpc: vi.fn() },
}));

import { handleTelegramWebhook, processTelegramQueueMessage } from "./telegram.server";

function verifiedRequest(update: unknown, secret = "a-secure-webhook-secret") {
  return new Request("https://app.example.com/api/webhooks/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body: JSON.stringify(update),
  });
}

function dependencies(receipts: Record<number, unknown>): TelegramServerDependencies {
  return {
    claimUpdate: vi.fn(async (updateId) => ({
      update_id: updateId,
      payload: receipts[updateId],
      attempts: 1,
    })),
    finishUpdate: vi.fn().mockResolvedValue(undefined),
    consumeState: vi.fn().mockResolvedValue({ userId: "owner" }),
    bindConnection: vi.fn().mockResolvedValue({
      id: ids.connection,
      userId: "owner",
      chatId: "99",
      displayName: "@creator",
      metadata: {},
    }),
    findConnection: vi.fn().mockResolvedValue({
      id: ids.connection,
      userId: "owner",
      chatId: "99",
      displayName: "@creator",
      metadata: {},
    }),
    saveThreadId: vi.fn().mockResolvedValue(undefined),
    requireContent: vi.fn().mockResolvedValue(undefined),
    rateLimit: vi.fn().mockResolvedValue(undefined),
    runAgent: vi.fn().mockResolvedValue({
      threadId: "11111111-1111-4111-8111-111111111111",
      messageId: ids.message,
      result: { action: "answer", message: "Here is the plan.", cards: [] },
    }),
    createActions: vi.fn().mockResolvedValue([]),
    claimAction: vi.fn().mockResolvedValue({
      id: ids.action,
      user_id: "owner",
      action_type: "approve_schedule",
      payload: {
        messageId: ids.message,
        draftCardId: "draft-1",
        scheduleCardId: "schedule-1",
      },
    }),
    approveSchedule: vi.fn().mockResolvedValue(undefined),
    approveBrain: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue(undefined),
    answerCallback: vi.fn().mockResolvedValue(undefined),
  };
}

describe("Telegram webhook intake", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = "123456:bot-token";
    process.env.TELEGRAM_BOT_USERNAME = "BentoAgentBot";
    process.env.TELEGRAM_WEBHOOK_SECRET = "a-secure-webhook-secret";
    mocks.receiptInsert.mockResolvedValue({ error: null });
  });

  it("rejects a webhook before enqueueing when the secret is wrong", async () => {
    const queue = { send: vi.fn() };
    const response = await handleTelegramWebhook(verifiedRequest(startUpdate, "wrong"), queue);
    expect(response.status).toBe(401);
    expect(queue.send).not.toHaveBeenCalled();
    expect(mocks.receiptInsert).not.toHaveBeenCalled();
  });

  it("stores and enqueues one verified update once", async () => {
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    expect((await handleTelegramWebhook(verifiedRequest(startUpdate), queue)).status).toBe(200);
    expect(queue.send).toHaveBeenCalledWith({ kind: "telegram_update", updateId: 42 });

    mocks.receiptInsert.mockResolvedValueOnce({ error: { code: "23505" } });
    expect((await handleTelegramWebhook(verifiedRequest(startUpdate), queue)).status).toBe(200);
    expect(queue.send).toHaveBeenCalledTimes(1);
  });
});

describe("Telegram queued processing", () => {
  it("binds /start and routes later text through the existing Agent", async () => {
    const deps = dependencies({ 42: startUpdate, 43: textUpdate });
    await processTelegramQueueMessage({ kind: "telegram_update", updateId: 42 }, deps);
    expect(deps.consumeState).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(deps.bindConnection).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "owner", chatId: "99" }),
    );

    await processTelegramQueueMessage({ kind: "telegram_update", updateId: 43 }, deps);
    expect(deps.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner",
        text: "Plan today's posts",
      }),
    );
    expect(deps.sendText).toHaveBeenCalledWith("99", "Here is the plan.", []);
  });

  it("claims callback actions before applying the shared approval", async () => {
    const deps = dependencies({ 44: callbackUpdate });
    await processTelegramQueueMessage({ kind: "telegram_update", updateId: 44 }, deps);
    expect(deps.claimAction).toHaveBeenCalledWith(ids.action, "99");
    expect(deps.approveSchedule).toHaveBeenCalledWith("owner", {
      messageId: ids.message,
      draftCardId: "draft-1",
      scheduleCardId: "schedule-1",
    });
    expect(deps.answerCallback).toHaveBeenCalledWith("callback-1", "Scheduled.");
  });
});
