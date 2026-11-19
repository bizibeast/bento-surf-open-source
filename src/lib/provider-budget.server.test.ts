import { afterEach, describe, expect, it, vi } from "vitest";
vi.unmock("./provider-budget.server");
import {
  aiReservationMicrousd,
  ProviderBudgetError,
  reserveProviderUsage,
  reserveAiProviderUsage,
  getManagedSpendStatus,
  withManagedProviderBudget,
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

  it("atomically reserves and settles managed AI using the trusted request scope", async () => {
    vi.stubEnv("DODO_FULLY_MANAGED_99_MONTHLY_PRODUCT_ID", "managed-product");
    vi.stubEnv("BENTO_FULLY_MANAGED_CHECKOUT_ENABLED", "false");
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: { allowed: true, reservation_id: reservationId },
        error: null,
      })
      .mockResolvedValueOnce({ data: true, error: null });
    const receipt = await withManagedProviderBudget(
      { workspaceId: "workspace-a", authUserId: "owner-a" },
      () =>
        withProviderBudgetWorkspace("workspace-a", () =>
          reserveAiProviderUsage(200, {
            client: { rpc },
            provider: "openrouter",
            model: "approved-model",
            attemptId: "attempt",
          }),
        ),
    );
    expect(receipt).toEqual({ id: reservationId, units: 200, managed: true });
    expect(rpc).toHaveBeenNthCalledWith(1, "reserve_managed_provider_usage", {
      p_workspace_id: "workspace-a",
      p_auth_user_id: "owner-a",
      p_product_id: "managed-product",
      p_attempt_id: "attempt",
      p_resource: "ai_microusd",
      p_provider_units: 200,
      p_microusd: 200,
      p_provider: "openrouter",
      p_model: "approved-model",
    });
    expect(await settleProviderUsage(receipt, 100, { client: { rpc } })).toBe(true);
    expect(rpc).toHaveBeenNthCalledWith(2, "settle_managed_provider_usage", {
      p_reservation_id: reservationId,
      p_actual_units: 100,
    });
  });

  it("blocks managed spend outside its trusted workspace and without a priced resource", async () => {
    vi.stubEnv("DODO_FULLY_MANAGED_99_MONTHLY_PRODUCT_ID", "managed-product");
    const rpc = vi.fn();
    await withManagedProviderBudget({ workspaceId: "workspace-a" }, async () => {
      await expect(
        reserveAiProviderUsage(100, {
          client: { rpc },
          workspaceId: "workspace-b",
          provider: "openrouter",
          model: "approved-model",
        }),
      ).rejects.toMatchObject({ reason: "ineligible" });
      await expect(
        reserveProviderUsage("brave_search_requests", 1, { client: { rpc } }),
      ).rejects.toMatchObject({ reason: "unavailable" });
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("exposes weekly managed resets and blocks self-hosted before any RPC", async () => {
    vi.stubEnv("DODO_FULLY_MANAGED_99_MONTHLY_PRODUCT_ID", "managed-product");
    vi.stubEnv("BENTO_EDITION", "");
    const rpc = vi.fn().mockResolvedValue({
      data: { allowed: false, reason: "managed_week", retry_at: "2026-11-16T00:00:00Z" },
      error: null,
    });
    await expect(
      withManagedProviderBudget({ workspaceId: "workspace-a" }, () =>
        reserveProviderUsage("brave_search_requests", 1, {
          client: { rpc },
          managedCostMicrousd: 5000,
        }),
      ),
    ).rejects.toMatchObject({ reason: "managed_week", message: expect.stringContaining("weekly") });
    expect(rpc).toHaveBeenCalledExactlyOnceWith(
      "reserve_managed_provider_usage",
      expect.objectContaining({
        p_workspace_id: "workspace-a",
        p_resource: "brave_search_requests",
        p_provider_units: 1,
        p_microusd: 5000,
      }),
    );
    vi.stubEnv("BENTO_EDITION", "self_hosted");
    rpc.mockClear();
    expect(await getManagedSpendStatus("workspace-a", { client: { rpc } })).toEqual({
      eligible: false,
      reason: "self_hosted",
    });
    expect(rpc).not.toHaveBeenCalled();
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
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reservation = { id: reservationId, units: 100 };
    for (const units of [null, -1, 101, Infinity, NaN, 0.1]) {
      expect(await settleProviderUsage(reservation, units, { client: { rpc } })).toBe(false);
    }
    expect(warning).toHaveBeenCalledWith("ai_usage_settlement_rejected", {
      reservationId,
      reason: "missing_cost",
      reservedUnits: 100,
      actualUnits: null,
    });
    expect(warning).toHaveBeenCalledWith("ai_usage_settlement_rejected", {
      reservationId,
      reason: "above_reservation",
      reservedUnits: 100,
      actualUnits: 101,
    });
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
