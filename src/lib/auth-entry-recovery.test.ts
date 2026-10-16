import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  entry: vi.fn(),
  getClaims: vi.fn(),
  redirect: vi.fn((options: unknown) => Object.assign(new Error("Redirect"), { options })),
}));
vi.mock("./workspace.functions", () => ({ getCreatorEntryState: state.entry }));
vi.mock("@tanstack/react-router", () => ({ redirect: state.redirect }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getClaims: state.getClaims },
  },
}));
import { requireAuthenticatedCreator } from "./auth-entry";
beforeEach(() => {
  vi.clearAllMocks();
  state.getClaims.mockResolvedValue({ data: { claims: { sub: "owner" } }, error: null });
  state.entry.mockResolvedValue({ workspaceId: "selected", onboarded: true, needsBilling: true });
});
describe("expired hosted workspace recovery", () => {
  it("loads a fresh login document for a signed-out product entry", async () => {
    state.getClaims.mockResolvedValue({ data: null, error: null });
    await expect(requireAuthenticatedCreator("/content", "/content?tab=agent")).rejects.toThrow("Redirect");
    expect(state.redirect).toHaveBeenCalledWith({
      to: "/login",
      search: { redirect: "/content?tab=agent" },
      reloadDocument: true,
    });
    expect(state.entry).not.toHaveBeenCalled();
  });
  it("keeps billing and content export reachable after hosted access ends", async () => {
    await expect(
      requireAuthenticatedCreator("/settings", "/settings?section=account"),
    ).resolves.toEqual({ userId: "owner" });
    await expect(requireAuthenticatedCreator("/onboarding", "/onboarding")).resolves.toEqual({
      userId: "owner",
    });
  });
  it("sends paid app entry to billing instead of treating an expired trial as active", async () => {
    await expect(requireAuthenticatedCreator("/content", "/content")).rejects.toThrow("Redirect");
    expect(state.redirect).toHaveBeenCalledWith({ to: "/settings", search: { section: "plan" } });
  });
  it("sends a new pending workspace to its own preparation", async () => {
    state.entry.mockResolvedValue({
      workspaceId: "pending",
      onboarded: false,
      needsBilling: false,
    });
    await expect(requireAuthenticatedCreator("/link", "/link")).rejects.toThrow("Redirect");
    expect(state.redirect).toHaveBeenCalledWith({ to: "/onboarding" });
  });
});
