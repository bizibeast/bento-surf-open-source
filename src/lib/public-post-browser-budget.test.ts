import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), reserve: vi.fn(), managed: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
vi.mock("./provider-budget.server", () => ({
  reserveProviderUsage: mocks.reserve,
  hasManagedProviderBudget: mocks.managed,
}));
import { withPublicPostBrowserBudget } from "./social-preview-reliability.server";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.rpc.mockResolvedValue({ data: true, error: null });
  mocks.reserve.mockResolvedValue(undefined);
  mocks.managed.mockReturnValue(false);
  vi.stubGlobal("__env__", { BROWSER: { fetch: vi.fn() } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("direct post browser accounting", () => {
  it("blocks before launch when the shared feature allowance is denied", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    const work = vi.fn();
    await expect(withPublicPostBrowserBudget(work)).rejects.toThrow("budget exhausted");
    expect(work).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("blocks before launch and releases its feature hold when the global reservation is denied", async () => {
    mocks.reserve.mockRejectedValue(new Error("Denied"));
    const work = vi.fn();
    await expect(withPublicPostBrowserBudget(work)).rejects.toThrow("Denied");
    expect(work).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      "adjust_social_preview_budget",
      expect.objectContaining({ p_delta: -40000 }),
    );
  });
  it("reserves the full session bound before execution and meters managed cost when applicable", async () => {
    mocks.managed.mockReturnValue(true);
    const work = vi.fn().mockResolvedValue({ value: "counts", browserClosed: false });
    expect(await withPublicPostBrowserBudget(work)).toBe("counts");
    expect(mocks.reserve).toHaveBeenCalledWith("browser_milliseconds", 40000, {
      managedCostMicrousd: 1000,
    });
    expect(mocks.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      work.mock.invocationCallOrder[0],
    );
    expect(
      mocks.rpc.mock.calls.filter(([name]) => name === "adjust_social_preview_budget"),
    ).toHaveLength(0);
  });
  it("reconciles confirmed closure against the original UTC period across midnight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-24T23:59:59.500Z"));
    await withPublicPostBrowserBudget(async () => {
      vi.setSystemTime(new Date("2026-11-25T00:00:00.500Z"));
      return { value: "counts", browserClosed: true };
    });
    expect(mocks.rpc).toHaveBeenLastCalledWith("adjust_social_preview_budget", {
      p_provider: "browser_run",
      p_period_start: "2026-11-24",
      p_delta: -39000,
    });
  });
});
