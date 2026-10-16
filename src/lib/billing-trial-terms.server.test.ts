import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  checkout: { trial_days: 3 } as { trial_days: number } | null,
  owner: null as null | {
    workspace_id: string;
    subscription_id: string;
    trial_days: number;
    extension_approved_until: string | null;
  },
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({
          data: table === "bento_trial_checkouts" ? state.checkout : state.owner,
          error: null,
        }),
      };
      return query;
    },
  },
}));
import { readTrialTerms } from "./billing-trial-terms.server";

const input = {
  workspaceId: "workspace",
  ownerId: "owner",
  checkoutKey: "key",
  subscriptionId: "sub",
};

beforeEach(() => {
  state.checkout = { trial_days: 3 };
  state.owner = null;
});

describe("server-authorized trial terms", () => {
  it("uses the checkout's three-day term for a new subscription", async () => {
    expect(await readTrialTerms(input)).toEqual({ days: 3, approvedExtensionEnd: null });
  });
  it("accepts an extension only for the same owner and subscription", async () => {
    state.owner = {
      workspace_id: "workspace",
      subscription_id: "sub",
      trial_days: 3,
      extension_approved_until: "2030-01-08T00:00:00Z",
    };
    expect(await readTrialTerms(input)).toEqual({
      days: 3,
      approvedExtensionEnd: "2030-01-08T00:00:00Z",
    });
    state.owner.subscription_id = "another-sub";
    await expect(readTrialTerms(input)).rejects.toThrow("ownership");
  });
  it("refuses a trial without a server-created checkout", async () => {
    state.checkout = null;
    await expect(readTrialTerms(input)).rejects.toThrow("checkout terms");
  });
});
