import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; args: unknown[] }>,
  access: vi.fn(),
}));

function query() {
  const value: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "upsert", "update"] as const) {
    value[method] = vi.fn((...args: unknown[]) => {
      mocks.calls.push({ method, args });
      return value;
    });
  }
  value.then = (resolve: (result: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null }).then(resolve);
  value.maybeSingle = vi.fn(async () => ({
    data: {
      id: "routine",
      schedule: { intervalMinutes: 1440, time: "09:00" },
      timezone: "Asia/Kolkata",
    },
    error: null,
  }));
  return value;
}

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (value: unknown) => value;
    const fn: Record<string, unknown> = {};
    fn.middleware = () => fn;
    fn.validator = (schema: (value: unknown) => unknown) => {
      validate = schema;
      return fn;
    };
    fn.handler =
      (handler: (input: { context: { userId: string }; data: unknown }) => unknown) =>
      (input?: { data?: unknown }) =>
        handler({ context: { userId: "owner" }, data: validate(input?.data) });
    return fn;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: () => query() },
}));
vi.mock("./content-access.server", () => ({ requireContentWorkspace: mocks.access }));

import {
  getContentRoutines,
  saveContentRoutine,
  setContentRoutinePaused,
} from "./content-routines.functions";

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.access.mockReset().mockResolvedValue("creator");
});

it("validates and saves only the authenticated creator's routine", async () => {
  await saveContentRoutine({
    data: {
      template: "fill_schedule",
      enabled: true,
      intervalMinutes: 1_440,
      time: "03:00",
      timezone: "Asia/Kolkata",
      platforms: ["linkedin"],
    },
  });
  expect(mocks.access).toHaveBeenCalledWith("owner");
  expect(mocks.calls.find((call) => call.method === "upsert")?.args[0]).toMatchObject({
    user_id: "owner",
    template: "fill_schedule",
  });
});

it("scopes listing and pause state to the authenticated creator", async () => {
  await getContentRoutines();
  await setContentRoutinePaused({
    data: { id: "11111111-1111-4111-8111-111111111111", paused: true },
  });
  expect(mocks.calls.filter((call) => call.method === "eq" && call.args[0] === "user_id")).toEqual(
    expect.arrayContaining([expect.objectContaining({ args: ["user_id", "owner"] })]),
  );
});

it("resumes a paused routine with a newly calculated next run", async () => {
  await setContentRoutinePaused({
    data: { id: "11111111-1111-4111-8111-111111111111", paused: false },
  });
  const update = mocks.calls.find((call) => call.method === "update")?.args[0] as {
    enabled: boolean;
    next_run_at: string;
  };
  expect(update.enabled).toBe(true);
  expect(new Date(update.next_run_at).getTime()).toBeGreaterThan(Date.now());
});

it("stores independent custom routines and rejects unsupported cadence", async () => {
  const value = {
    template: "custom:11111111-1111-4111-8111-111111111111",
    name: "Weekly plan",
    instructions: "Prepare a sourced LinkedIn plan.",
    enabled: false,
    intervalMinutes: 10080,
    time: "09:00",
    timezone: "Asia/Kolkata",
    platforms: ["linkedin"],
  };
  await saveContentRoutine({ data: value });
  expect(mocks.calls.find((call) => call.method === "upsert")?.args[0]).toMatchObject({
    schedule: { name: "Weekly plan", instructions: "Prepare a sourced LinkedIn plan." },
    next_run_at: null,
  });
  expect(() => saveContentRoutine({ data: { ...value, intervalMinutes: 15 } })).toThrow();
});
