/* eslint-disable @typescript-eslint/no-explicit-any -- Test doubles model the server function and Supabase query chain. */
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sync: vi.fn(),
  getPlan: vi.fn(),
  single: vi.fn(),
  maybeSingle: vi.fn(),
  from: vi.fn(),
  update: vi.fn(),
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
    from: (table: string) => {
      mocks.from(table);
      const query: any = {
        update: (values: unknown) => {
          mocks.update(values);
          return query;
        },
        eq: () => query,
        is: () => query,
        select: () => query,
        single: mocks.single,
        maybeSingle: mocks.maybeSingle,
        then: (resolve: (value: unknown) => void) => resolve({ error: null }),
      };
      return query;
    },
  },
}));
vi.mock("./pages.functions", () => ({ setSystemPageVisibility: mocks.sync }));
vi.mock("./plan.server", () => ({ getPlan: mocks.getPlan }));

import {
  failSocialInsightsBackfillMessage,
  setPublicSocialInsights,
} from "./social-analytics.functions";
import { ProviderError } from "./social-publisher.server";

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

it.each(["account", "content"] as const)(
  "keeps publishing connected when the %s insights stage receives HTTP 401",
  async (stage) => {
    await failSocialInsightsBackfillMessage(
      {
        kind: "social_insights_backfill",
        userId: "owner",
        connectionId: "connection",
        jobId: "job",
        stage,
        cursor: null,
        startedAt: "2026-10-08T00:00:00.000Z",
      },
      new ProviderError("Analytics request was unauthorized", "190", false, 401),
    );

    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.from).toHaveBeenCalledWith("social_analytics_snapshots");
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        refresh_job_id: null,
        next_refresh_at: expect.any(String),
        note: "Social insights could not authenticate with this provider. Publishing access may still work.",
      }),
    );
  },
);
