import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ delays: [60], fail: false, calls: [] as unknown[][] }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in"])
        chain[method] = (...args: unknown[]) => {
          state.calls.push([table, method, ...args]);
          return chain;
        };
      chain.limit = async () => ({
        error: state.fail ? new Error("offline") : null,
        data:
          table === "social_connections"
            ? [{ user_id: "owner" }]
            : state.delays.map((auto_dm_delay_seconds) => ({ auto_dm_delay_seconds })),
      });
      return chain;
    },
  },
}));
import { deferAutoDmDelivery } from "./auto-dm-delay.server";
import { autoDmDelaySchema } from "./auto-dm-delay";
const now = Date.now();
beforeEach(() => {
  state.delays = [60];
  state.fail = false;
  state.calls = [];
});
describe("Auto DM queue delay", () => {
  it.each(["instagram", "facebook", "twitter"] as const)(
    "delays %s without provider calls or claiming a workflow",
    async (provider) => {
      const retry = vi.fn();
      expect(
        await deferAutoDmDelivery(provider, "account", { timestamp: new Date(now), retry }, now),
      ).toBe(true);
      expect(retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
      expect(state.calls).toContainEqual(["social_connections", "eq", "provider", provider]);
      expect(state.calls).toContainEqual(["profiles", "in", "id", ["owner"]]);
    },
  );
  it.each([30, 60, 120, 180])("respects %i seconds across retries", async (delay) => {
    state.delays = [delay];
    const retry = vi.fn();
    const message = { timestamp: new Date(now), retry };
    expect(await deferAutoDmDelivery("instagram", "account", message, now + 10_000)).toBe(true);
    expect(retry).toHaveBeenLastCalledWith({ delaySeconds: delay - 10 });
    retry.mockClear();
    expect(await deferAutoDmDelivery("instagram", "account", message, now + delay * 1000)).toBe(
      false,
    );
    expect(retry).not.toHaveBeenCalled();
  });
  it("uses the longest delay for shared accounts and fails closed on unavailable settings", async () => {
    state.delays = [30, 180];
    const retry = vi.fn();
    const message = { timestamp: new Date(now), retry };
    await deferAutoDmDelivery("facebook", "account", message, now);
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 180 });
    state.fail = true;
    await expect(deferAutoDmDelivery("facebook", "account", message, now)).rejects.toThrow();
  });
  it("does not re-query settings after the maximum wait", async () => {
    state.fail = true;
    expect(
      await deferAutoDmDelivery(
        "twitter",
        "account",
        { timestamp: new Date(now - 180_000), retry: vi.fn() },
        now,
      ),
    ).toBe(false);
    expect(state.calls).toHaveLength(0);
  });
  it.each([0, 1, 29, 31, 181, 10000, "60"])("rejects unsupported delay %s", (value) => {
    expect(autoDmDelaySchema.safeParse(value).success).toBe(false);
  });
});
