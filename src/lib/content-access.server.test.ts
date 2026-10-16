import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requirePlanEntitlement: vi.fn() }));

vi.mock("./plan.server", () => ({
  requirePlanEntitlement: mocks.requirePlanEntitlement,
}));

import { requireContentWorkspace } from "./content-access.server";

beforeEach(() => vi.clearAllMocks());

it("requires Brain access for the AI workspace", async () => {
  mocks.requirePlanEntitlement.mockResolvedValue("creator");
  await expect(requireContentWorkspace("creator-id")).resolves.toBe("creator");
  expect(mocks.requirePlanEntitlement).toHaveBeenCalledWith(
    "creator-id",
    "brain",
    "Brain is included with the Creator Plus plan. Upgrade to continue.",
  );
});

it("allows Discover through its independent Creator entitlement", async () => {
  mocks.requirePlanEntitlement.mockResolvedValue("creator");
  await requireContentWorkspace("creator-id", "discover");
  expect(mocks.requirePlanEntitlement).toHaveBeenCalledWith(
    "creator-id",
    "discover",
    "Discover is included with the Creator plan. Upgrade to continue.",
  );
});

it("preserves the plan gate rejection", async () => {
  mocks.requirePlanEntitlement.mockRejectedValue(new Error("Upgrade"));
  await expect(requireContentWorkspace("store-id")).rejects.toThrow("Upgrade");
});
