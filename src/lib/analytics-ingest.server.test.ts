import { describe, expect, it, vi } from "vitest";

import { handleAnalyticsEventRequest } from "./analytics-ingest.server";

const validPayload = {
  event_id: "11111111-1111-4111-8111-111111111111",
  kind: "view",
  user_id: "22222222-2222-4222-8222-222222222222",
  visitor_hash: "visitor-1",
};

describe("analytics ingestion endpoint", () => {
  it("fails gracefully when local development has no Worker bindings", async () => {
    const response = await handleAnalyticsEventRequest(
      new Request("http://localhost:8080/api/events", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:8080" },
        body: JSON.stringify(validPayload),
      }),
      undefined,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Analytics ingestion is unavailable",
    });
  });

  it("queues a valid same-origin event", async () => {
    const send = vi.fn<(event: unknown) => Promise<void>>(async () => undefined);
    const response = await handleAnalyticsEventRequest(
      new Request("https://bento.surf/api/events", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://bento.surf" },
        body: JSON.stringify(validPayload),
      }),
      { ANALYTICS_QUEUE: { send } as unknown as Queue },
    );

    expect(response.status).toBe(202);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      event_id: validPayload.event_id,
      user_id: validPayload.user_id,
      kind: "view",
    });
  });

  it("spreads creators deterministically across configured queue shards", async () => {
    const sends = Array.from({ length: 4 }, () => vi.fn(async () => undefined));
    const env = {
      ANALYTICS_QUEUE: { send: sends[0] } as unknown as Queue,
      ANALYTICS_QUEUE_1: { send: sends[1] } as unknown as Queue,
      ANALYTICS_QUEUE_2: { send: sends[2] } as unknown as Queue,
      ANALYTICS_QUEUE_3: { send: sends[3] } as unknown as Queue,
    };

    for (let index = 0; index < 20; index += 1) {
      const userId = `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`;
      await handleAnalyticsEventRequest(
        new Request("https://bento.surf/api/events", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://bento.surf" },
          body: JSON.stringify({ ...validPayload, user_id: userId }),
        }),
        env,
      );
    }

    expect(sends.filter((send) => send.mock.calls.length > 0).length).toBe(4);
    expect(sends.reduce((count, send) => count + send.mock.calls.length, 0)).toBe(20);
  });

  it("drops analytics abuse before it reaches a queue", async () => {
    const send = vi.fn(async () => undefined);
    const limit = vi.fn(async () => ({ success: false }));
    const response = await handleAnalyticsEventRequest(
      new Request("https://bento.surf/api/events", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://bento.surf" },
        body: JSON.stringify(validPayload),
      }),
      {
        ANALYTICS_QUEUE: { send } as unknown as Queue,
        ANALYTICS_RATE_LIMITER: { limit },
      },
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(limit).toHaveBeenCalledWith({
      key: `${validPayload.user_id}:missing-cloudflare-ip`,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("fails closed when deployed analytics rate limiting is missing", async () => {
    const response = await handleAnalyticsEventRequest(
      new Request("https://bento.surf/api/events", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://bento.surf" },
        body: JSON.stringify(validPayload),
      }),
      { APP_ENV: "production", ANALYTICS_QUEUE: { send: vi.fn() } as unknown as Queue },
    );

    expect(response.status).toBe(503);
  });

  it("keeps queue delivery in the Worker lifetime without delaying acknowledgement", async () => {
    let finishDelivery: (() => void) | undefined;
    const send = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDelivery = resolve;
        }),
    );
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();

    const response = await handleAnalyticsEventRequest(
      new Request("https://bento.surf/api/events", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://bento.surf" },
        body: JSON.stringify(validPayload),
      }),
      { ANALYTICS_QUEUE: { send } as unknown as Queue },
      { waitUntil },
    );

    expect(response.status).toBe(202);
    expect(waitUntil).toHaveBeenCalledOnce();
    finishDelivery?.();
    await waitUntil.mock.calls[0]?.[0];
  });

  it("rejects cross-origin and oversized events before queueing", async () => {
    const send = vi.fn<(event: unknown) => Promise<void>>(async () => undefined);
    const queue = { ANALYTICS_QUEUE: { send } as unknown as Queue };
    const crossOrigin = await handleAnalyticsEventRequest(
      new Request("https://bento.surf/api/events", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://attacker.example" },
        body: JSON.stringify(validPayload),
      }),
      queue,
    );
    const oversized = await handleAnalyticsEventRequest(
      new Request("https://bento.surf/api/events", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "3000" },
        body: JSON.stringify(validPayload),
      }),
      queue,
    );

    expect(crossOrigin.status).toBe(403);
    expect(oversized.status).toBe(413);
    expect(send).not.toHaveBeenCalled();
  });
});
