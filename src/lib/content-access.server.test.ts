import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requirePlanEntitlement: vi.fn() }));

vi.mock("./plan.server", () => ({
  requirePlanEntitlement: mocks.requirePlanEntitlement,
}));

import { requireContentWorkspace } from "./content-access.server";

beforeEach(() => vi.clearAllMocks());

it("uses the existing post scheduler entitlement as the Content workspace gate", async () => {
  mocks.requirePlanEntitlement.mockResolvedValue("creator");
  await expect(requireContentWorkspace("creator-id")).resolves.toBe("creator");
  expect(mocks.requirePlanEntitlement).toHaveBeenCalledWith(
    "creator-id",
    "postScheduler",
    "Content is included in the Creator plan. Upgrade to continue.",
  );
});

it("preserves the plan gate rejection", async () => {
  mocks.requirePlanEntitlement.mockRejectedValue(new Error("Upgrade"));
  await expect(requireContentWorkspace("store-id")).rejects.toThrow("Upgrade");
});
