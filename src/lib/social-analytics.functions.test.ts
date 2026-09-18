import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sync: vi.fn(),
  getPlan: vi.fn(),
  single: vi.fn(),
  maybeSingle: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: any) => fn,
  createServerFn: () => {
    let validate = (data: any) => data;
    const fn: any = {
      middleware: () => fn,
      validator: (value: any) => {
        validate = value;
        return fn;
      },
      handler: (handler: any) => (input: any) =>
        handler({
          data: validate(input?.data),
          context: { userId: "owner", supabase: "authenticated-client" },
        }),
    };
    return fn;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      const query: any = {
        update: () => query,
        eq: () => query,
        select: () => query,
        single: mocks.single,
        maybeSingle: mocks.maybeSingle,
      };
      return query;
    },
  },
}));
vi.mock("./pages.functions", () => ({ setSystemPageVisibility: mocks.sync }));
vi.mock("./plan.server", () => ({ getPlan: mocks.getPlan }));

import { setPublicSocialInsights } from "./social-analytics.functions";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPlan.mockResolvedValue("creator");
  mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
  mocks.sync.mockResolvedValue({});
});

it.each([true, false])("syncs insights visibility %s", async (enabled) => {
  mocks.single.mockResolvedValue({
    data: { username: "owner", social_insights_enabled: enabled },
    error: null,
  });
  await setPublicSocialInsights({ data: { enabled } });
  expect(mocks.sync).toHaveBeenCalledWith("authenticated-client", "owner", "insights", enabled);
});

it("preserves the Insights plan gate", async () => {
  mocks.getPlan.mockResolvedValue("free");
  await expect(setPublicSocialInsights({ data: { enabled: true } })).rejects.toThrow("Upgrade");
  expect(mocks.sync).not.toHaveBeenCalled();
});
