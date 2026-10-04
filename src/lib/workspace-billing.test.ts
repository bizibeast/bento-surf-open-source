import { beforeEach, describe, expect, it, vi } from "vitest";
import checkoutSql from "../../supabase/migrations/20260920190417_additional_workspace_checkout.sql?raw";

const ids = {
  auth: "11111111-1111-4111-8111-111111111111",
  current: "22222222-2222-4222-8222-222222222222",
  pending: "33333333-3333-4333-8333-333333333333",
};

const mocks = vi.hoisted(() => ({
  checkoutCreate: vi.fn(),
  rpc: vi.fn(),
  deleteProfile: vi.fn(),
  subscription: {
    plan_id: "creator",
    status: "active",
    dodo_subscription_id: "sub_current",
    billing_interval: "yearly",
    contact_tier_contacts: 500,
    storage_addon_units: 0,
  } as Record<string, unknown>,
}));

function subscriptionQuery() {
  const query: Record<string, unknown> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.maybeSingle = vi.fn(async () => ({ data: mocks.subscription, error: null }));
  return query;
}

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (value: unknown) => value;
    const builder: Record<string, unknown> = {};
    builder.middleware = () => builder;
    builder.validator = (validator: (value: unknown) => unknown) => {
      validate = validator;
      return builder;
    };
    builder.handler =
      (handler: (input: { data: unknown; context: Record<string, unknown> }) => unknown) =>
      (input?: { data?: unknown }) =>
        handler({
          data: validate(input?.data),
          context: {
            userId: ids.current,
            workspaceId: ids.current,
            authUserId: ids.auth,
            claims: { sub: ids.auth, email: "owner@example.com" },
            supabase: { from: () => subscriptionQuery() },
          },
        });
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: mocks.rpc,
    from: () => {
      const query: Record<string, unknown> = {};
      query.delete = vi.fn(() => query);
      query.eq = vi.fn((column: string, value: string) => {
        if (column === "id") mocks.deleteProfile(value);
        return query;
      });
      query.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ error: null }).then(resolve);
      return query;
    },
  },
}));
vi.mock("@/integrations/dodo/client.server", () => ({
  dodo: {
    checkoutSessions: { create: mocks.checkoutCreate },
    subscriptions: {
      update: vi.fn(),
      retrieve: vi.fn(),
      changePlan: vi.fn(),
    },
  },
}));
vi.mock("./request-security.server", () => ({ enforceRequestRateLimit: vi.fn() }));

import { beginAdditionalWorkspaceCheckout } from "./billing.functions";

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(process.env, {
    DODO_CREATOR_YEARLY_PRODUCT_ID: "creator-yearly",
    VITE_APP_URL: "https://app.example.com",
  });
  Object.assign(mocks.subscription, {
    plan_id: "creator",
    status: "active",
    dodo_subscription_id: "sub_current",
    billing_interval: "yearly",
  });
  mocks.rpc.mockResolvedValue({ data: ids.pending, error: null });
  mocks.checkoutCreate.mockResolvedValue({
    checkout_url: "https://checkout.dodopayments.com/add-workspace",
  });
});

describe("additional workspace checkout", () => {
  it("creates pending profile and owner membership in one service-only transaction", () => {
    expect(checkoutSql).toContain("create function public.create_pending_workspace");
    expect(checkoutSql).toContain("insert into public.profiles");
    expect(checkoutSql).toContain("insert into public.workspace_memberships");
    expect(checkoutSql).toContain(
      "revoke all on function public.create_pending_workspace(uuid, text, text) from public",
    );
  });

  it("creates a pending workspace checkout with the current paid plan and interval", async () => {
    await expect(
      beginAdditionalWorkspaceCheckout({
        data: { displayName: "Second Studio", username: "second_studio" },
      }),
    ).resolves.toEqual({
      checkoutUrl: "https://checkout.dodopayments.com/add-workspace",
      workspaceId: ids.pending,
    });

    expect(mocks.rpc).toHaveBeenCalledWith("create_pending_workspace", {
      p_auth_user_id: ids.auth,
      p_display_name: "Second Studio",
      p_username: "second_studio",
    });
    expect(mocks.checkoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        product_cart: [{ product_id: "creator-yearly", quantity: 1 }],
        metadata: expect.objectContaining({
          auth_user_id: ids.auth,
          workspace_id: ids.pending,
        }),
      }),
    );
  });

  it("requires a current paid subscription", async () => {
    Object.assign(mocks.subscription, {
      plan_id: "free",
      status: "canceled",
      dodo_subscription_id: null,
      billing_interval: null,
    });

    await expect(
      beginAdditionalWorkspaceCheckout({
        data: { displayName: "Second Studio", username: "second_studio" },
      }),
    ).rejects.toThrow("Choose a paid plan first.");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("does not start checkout when the username already exists", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "23505", message: "profiles_username_key" },
    });

    await expect(
      beginAdditionalWorkspaceCheckout({
        data: { displayName: "Second Studio", username: "second_studio" },
      }),
    ).rejects.toThrow("Username already taken");
    expect(mocks.checkoutCreate).not.toHaveBeenCalled();
  });
});
