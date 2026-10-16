import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  completed: false,
  dismissed: false,
  resultCount: 0,
  from: vi.fn(),
  upsert: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (value: unknown) => value;
    const chain = {
      middleware: () => chain,
      validator: (schema: (value: unknown) => unknown) => {
        validate = schema;
        return chain;
      },
      handler:
        (handler: (input: { context: { userId: string }; data: unknown }) => unknown) =>
        (input?: { data?: unknown }) =>
          handler({ context: { userId: "workspace" }, data: validate(input?.data) }),
    };
    return chain;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("../plan.server", () => ({ hasPlanEntitlement: vi.fn().mockResolvedValue(true) }));
vi.mock("./session.server", () => ({ onboardingDb: { from: mocks.from } }));
import { getAppGuide } from "./apps.functions";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.completed = false;
  mocks.dismissed = false;
  mocks.resultCount = 0;
  mocks.upsert.mockImplementation(async () => {
    mocks.completed = true;
    return { error: null };
  });
  mocks.from.mockImplementation((table: string) => {
    const read = () => ({
      data:
        table === "profiles"
          ? { display_name: "Ari" }
          : table === "app_onboarding_progress"
            ? {
                completed_at: mocks.completed ? "2026-10-16T00:00:00Z" : null,
                dismissed_at: mocks.dismissed ? "2026-10-16T00:00:00Z" : null,
              }
            : { status: "applied", brief: {} },
      count: mocks.resultCount,
      error: null,
    });
    const query = {
      select: () => query,
      eq: () => query,
      single: async () => read(),
      maybeSingle: async () => read(),
      upsert: mocks.upsert,
      then: (resolve: (value: ReturnType<typeof read>) => unknown) =>
        Promise.resolve(read()).then(resolve),
    };
    return query;
  });
});
it("keeps completed setup hidden after example records are removed and skips proof queries", async () => {
  mocks.completed = true;
  const guide = await getAppGuide({ data: { appId: "newsletter" } });
  expect(guide.complete).toBe(true);
  expect(guide.showInitially).toBe(false);
  expect(mocks.from.mock.calls.map(([table]) => table)).toEqual([
    "profiles",
    "app_onboarding_progress",
    "onboarding_sessions",
  ]);
  expect(mocks.upsert).not.toHaveBeenCalled();
});
it("skips readiness scans for a permanently dismissed guide", async () => {
  mocks.dismissed = true;
  const guide = await getAppGuide({ data: { appId: "newsletter" } });
  expect(guide.dismissed).toBe(true);
  expect(guide.showInitially).toBe(false);
  expect(mocks.from.mock.calls.map(([table]) => table)).toEqual([
    "profiles",
    "app_onboarding_progress",
    "onboarding_sessions",
  ]);
  expect(mocks.upsert).not.toHaveBeenCalled();
});
it("records the completion milestone only when all real proofs exist", async () => {
  const pending = await getAppGuide({ data: { appId: "newsletter" } });
  expect(pending.complete).toBe(false);
  expect(mocks.upsert).not.toHaveBeenCalled();
  mocks.resultCount = 1;
  const ready = await getAppGuide({ data: { appId: "newsletter" } });
  expect(ready.complete).toBe(true);
  expect(mocks.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      workspace_id: "workspace",
      app_id: "newsletter",
      completed_at: expect.any(String),
    }),
    { onConflict: "workspace_id,app_id" },
  );
});
