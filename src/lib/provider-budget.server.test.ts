import { afterEach, describe, expect, it, vi } from "vitest";
vi.unmock("./provider-budget.server");
import {
  aiReservationMicrousd,
  ProviderBudgetError,
  reserveProviderUsage,
  reserveXRead,
  withProviderBudgetWorkspace,
  xBackgroundReadsEnabled,
} from "./provider-budget.server";

describe("provider cost reservations", () => {
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
