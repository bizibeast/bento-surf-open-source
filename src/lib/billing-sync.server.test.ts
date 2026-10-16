import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc: m.rpc } }));
import { withWorkspaceBillingSync, applyWorkspaceBillingSnapshot } from "./billing-sync.server";
beforeEach(() => vi.resetAllMocks());
it("does not allow a second provider observation while the first reconciliation is in flight", async () => {
  let leased = false;
  m.rpc.mockImplementation(async (name: string) => {
    if (name === "claim_workspace_billing_sync") {
      if (leased) return { data: null };
      leased = true;
      return { data: "lease" };
    }
    if (name === "release_workspace_billing_sync") leased = false;
    return { error: null };
  });
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = withWorkspaceBillingSync("workspace", async () => {
    await waiting;
    return "first";
  });
  await Promise.resolve();
  const secondProvider = vi.fn();
  await expect(withWorkspaceBillingSync("workspace", secondProvider)).rejects.toThrow(
    "being updated",
  );
  expect(secondProvider).not.toHaveBeenCalled();
  release();
  await expect(first).resolves.toBe("first");
  await expect(
    withWorkspaceBillingSync("workspace", async () => "fresh provider read"),
  ).resolves.toBe("fresh provider read");
});
it("releases the lease after provider failure so delivery can retry", async () => {
  m.rpc.mockResolvedValue({ data: "lease", error: null });
  await expect(
    withWorkspaceBillingSync("workspace", async () => {
      throw new Error("provider offline");
    }),
  ).rejects.toThrow("provider offline");
  expect(m.rpc).toHaveBeenLastCalledWith("release_workspace_billing_sync", {
    p_workspace_id: "workspace",
    p_lease_key: "lease",
  });
});
it("passes the lease to atomic persistence and fails when it is no longer valid", async () => {
  m.rpc.mockResolvedValue({ error: { message: "Billing reconciliation lease expired." } });
  await expect(
    applyWorkspaceBillingSnapshot("workspace", "stale", { plan_id: "free" }, null),
  ).rejects.toThrow("could not be synchronized");
  expect(m.rpc).toHaveBeenCalledWith("apply_workspace_billing_snapshot", {
    p_workspace_id: "workspace",
    p_lease_key: "stale",
    p_subscription: { plan_id: "free" },
    p_lifecycle: null,
  });
});
