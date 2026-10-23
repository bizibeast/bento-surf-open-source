import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  actor: "22222222-2222-4222-8222-222222222222",
  workspace: "11111111-1111-4111-8111-111111111111",
  adminIds: [] as string[],
  rpc: vi.fn(),
  from: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    let validate = (input: unknown) => input;
    const builder = {
      middleware: () => builder,
      validator: (next: typeof validate) => {
        validate = next;
        return builder;
      },
      handler:
        (
          fn: (input: {
            data: unknown;
            context: { userId: string; workspaceId: string; authUserId: string };
          }) => unknown,
        ) =>
        (input?: { data?: unknown }) =>
          fn({
            data: validate(input?.data),
            context: {
              userId: mocks.workspace,
              workspaceId: mocks.workspace,
              authUserId: mocks.actor,
            },
          }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
import { getFounderAffiliates, setReferralAccountRate } from "./referral-admin.functions";

describe("referral founder actor authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("APP_ENV", "production");
    mocks.adminIds = [];
    mocks.rpc.mockResolvedValue({ data: { ok: true }, error: null });
    mocks.from.mockImplementation((table: string) => {
      if (table !== "user_roles") throw new Error("Unauthorized data query");
      let actor = "";
      const query = {
        select: () => query,
        eq: (key: string, value: string) => {
          if (key === "user_id") actor = value;
          return query;
        },
        maybeSingle: async () => ({
          data: mocks.adminIds.includes(actor) ? { id: "admin-role" } : null,
          error: null,
        }),
      };
      return query;
    });
  });
  afterEach(() => vi.unstubAllEnvs());
  it("denies reads and mutations for a regular member in an admin-owned workspace", async () => {
    mocks.adminIds = [mocks.workspace];
    await expect(getFounderAffiliates()).rejects.toThrow("Admin access required");
    await expect(
      setReferralAccountRate({
        data: { accountId: "33333333-3333-4333-8333-333333333333", commissionRateBps: 2000 },
      }),
    ).rejects.toThrow("Admin access required");
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.from.mock.calls.map(([table]) => table)).toEqual(["user_roles", "user_roles"]);
  });
  it("allows the actual founder and records the actor instead of the selected workspace owner", async () => {
    mocks.adminIds = [mocks.actor];
    await setReferralAccountRate({
      data: { accountId: "33333333-3333-4333-8333-333333333333", commissionRateBps: 2000 },
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "admin_set_referral_account_rate",
      expect.objectContaining({ p_admin_user_id: mocks.actor }),
    );
  });
});
