import { afterEach, describe, expect, it, vi } from "vitest";
vi.unmock("./provider-budget.server");
import {
  aiReservationMicrousd,
  ProviderBudgetError,
  reserveProviderUsage,
  reserveAiProviderUsage,
  settleProviderUsage,
  reserveXRead,
  withProviderBudgetWorkspace,
  xBackgroundReadsEnabled,
} from "./provider-budget.server";

describe("provider cost reservations", () => {
  const reservationId = "10000000-0000-4000-8000-000000000001";
  it("fails closed if the AI reservation receipt is missing or the database is unavailable", async () => {
    for (const response of [
      { data: null, error: null },
      { data: true, error: null },
      { data: { allowed: true }, error: null },
      { data: { allowed: true, reservation_id: "invalid" }, error: null },
      { data: { allowed: true, reservation_id: reservationId }, error: new Error("offline") },
    ]) {
      await expect(
        reserveAiProviderUsage(100, {
          provider: "workers-ai",
          model: "@cf/openai/gpt-oss-20b",
          client: { rpc: vi.fn().mockResolvedValue(response) },
        }),
      ).rejects.toBeInstanceOf(ProviderBudgetError);
    }
  });

  it("bounds accounting latency without retrying a completed provider request", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rpc = vi.fn().mockImplementation(() => new Promise(() => {}));
      const result = settleProviderUsage({ id: reservationId, units: 100 }, 10, {
        client: { rpc },
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await result).toBe(false);
      expect(rpc).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  });
  it("creates one atomic receipt for public and workspace AI limits", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: { allowed: true, reservation_id: reservationId }, error: null });
    const result = await withProviderBudgetWorkspace("workspace-a", () =>
      reserveAiProviderUsage(100, {
        client: { rpc },
        provider: "workers-ai",
        model: "@cf/openai/gpt-oss-20b",
        publicTool: true,
      }),
    );
    expect(result).toEqual({ id: reservationId, units: 100 });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("reserve_ai_provider_usage", {
      p_units: 100,
      p_workspace_id: "workspace-a",
      p_provider: "workers-ai",
      p_model: "@cf/openai/gpt-oss-20b",
      p_public_tool: true,
    });
  });

  it("keeps the actual reset deadline on denied AI reservations", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { allowed: false, reason: "workspace_month", retry_at: "2026-11-01T00:00:00Z" },
      error: null,
    });
    await expect(
      reserveAiProviderUsage(100, {
        client: { rpc },
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.5",
      }),
    ).rejects.toMatchObject({
      name: "ProviderBudgetError",
      reason: "workspace_month",
      retryAt: "2026-11-01T00:00:00.000Z",
      message: expect.stringContaining("2026-11-01"),
    });
  });

  it("settles only a valid receipt and never credits missing or oversized usage", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    const reservation = { id: reservationId, units: 100 };
    for (const units of [null, -1, 101, Infinity, NaN, 0.1]) {
      expect(await settleProviderUsage(reservation, units, { client: { rpc } })).toBe(false);
    }
    expect(rpc).not.toHaveBeenCalled();
    expect(await settleProviderUsage(reservation, 20, { client: { rpc } })).toBe(true);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("settle_ai_provider_usage", {
      p_reservation_id: reservationId,
      p_actual_units: 20,
    });
  });

  it("retains the reservation when settlement storage is unavailable", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rpc = vi.fn().mockRejectedValue(new Error("database unavailable"));
    expect(
      await settleProviderUsage({ id: reservationId, units: 100 }, 10, { client: { rpc } }),
    ).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
    warning.mockRestore();
  });
  afterEach(() => vi.unstubAllEnvs());
  it("fails closed on rejected, missing and failed reservations", async () => {
    for (const response of [
      { data: false, error: null },
      { data: null, error: null },
      { data: true, error: new Error("offline") },
    ]) {
      await expect(
        reserveProviderUsage("apimart_images", 1, {
          client: { rpc: vi.fn().mockResolvedValue(response) },
        }),
      ).rejects.toBeInstanceOf(ProviderBudgetError);
    }
    await expect(
      reserveProviderUsage("apimart_images", 1, {
        client: { rpc: vi.fn().mockRejectedValue(new Error("offline")) },
      }),
    ).rejects.toBeInstanceOf(ProviderBudgetError);
  });
  it("isolates concurrent trusted workspace reservations", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    await Promise.all(
      ["workspace-a", "workspace-b"].map((id) =>
        withProviderBudgetWorkspace(id, async () => {
          await Promise.resolve();
          await reserveProviderUsage("ai_microusd", 123, { client: { rpc } });
        }),
      ),
    );
    expect(rpc.mock.calls.map(([, args]) => args.p_workspace_id).sort()).toEqual([
      "workspace-a",
      "workspace-b",
    ]);
    await reserveProviderUsage("ai_microusd", 123, { client: { rpc } });
    expect(rpc.mock.lastCall?.[1].p_workspace_id).toBeNull();
  });
  it("rejects invalid amounts before querying", async () => {
    const rpc = vi.fn();
    for (const units of [NaN, Infinity, 0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1])
      await expect(
        reserveProviderUsage("apimart_images", units, { client: { rpc } }),
      ).rejects.toBeInstanceOf(ProviderBudgetError);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("counts UTF-8 bytes and full output, and rejects oversized prompts/models", () => {
    expect(aiReservationMicrousd(["🦊"], 100)).toBeGreaterThan(aiReservationMicrousd(["a"], 100));
    expect(aiReservationMicrousd([], 101) - aiReservationMicrousd([], 100)).toBe(15);
    expect(() => aiReservationMicrousd("a".repeat(128001), 100)).toThrow(/too large/);
    expect(() => aiReservationMicrousd([], 8001)).toThrow(/too large/);
  });
  it("disables paid X content reads by default without touching the provider or database", async () => {
    vi.stubEnv("X_PAID_READS_ENABLED", "");
    expect(xBackgroundReadsEnabled()).toBe(false);
    await expect(
      reserveXRead("https://api.x.com/2/users/1/tweets?max_results=100"),
    ).rejects.toBeInstanceOf(ProviderBudgetError);
    await expect(reserveXRead("https://api.linkedin.com/rest/posts")).resolves.toBeUndefined();
  });
});
