import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: database }));

import {
  appendPriorityDmMessageAndNotify,
  markCreatorPriorityDmReadIfCurrent,
} from "./priority-dm.functions";

const requestId = "11111111-1111-4111-8111-111111111111";

describe("appendPriorityDmMessageAndNotify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.rpc.mockResolvedValue({ data: { id: "message-1" }, error: null });
  });

  it.each(["creator", "buyer"] as const)(
    "returns the saved %s message when notification enqueue fails",
    async (sender) => {
      const enqueue = vi.fn().mockRejectedValue(new Error("email unavailable"));
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

      await expect(
        appendPriorityDmMessageAndNotify(
          { requestId, sender, body: "Saved once", orderId: null },
          enqueue,
        ),
      ).resolves.toEqual({ id: "message-1" });

      expect(database.rpc).toHaveBeenCalledOnce();
      expect(enqueue).toHaveBeenCalledWith({ requestId, messageId: "message-1" });
      expect(log).toHaveBeenCalledOnce();
      log.mockRestore();
    },
  );
});

describe("markCreatorPriorityDmReadIfCurrent", () => {
  it("updates only the expected unread message version", async () => {
    const result = { error: null };
    const query = {
      eq: vi.fn(),
      then: (onFulfilled: (value: typeof result) => unknown) =>
        Promise.resolve(result).then(onFulfilled),
    };
    query.eq.mockReturnValue(query);
    const update = vi.fn().mockReturnValue(query);
    const client = { from: vi.fn().mockReturnValue({ update }) };
    const lastMessageAt = "2026-08-30T03:00:00.000Z";

    await markCreatorPriorityDmReadIfCurrent(client, {
      requestId,
      creatorId: "22222222-2222-4222-8222-222222222222",
      lastMessageAt,
    });

    expect(query.eq.mock.calls).toEqual([
      ["id", requestId],
      ["creator_id", "22222222-2222-4222-8222-222222222222"],
      ["status", "unread"],
      ["last_message_at", lastMessageAt],
    ]);
  });
});
