/* eslint-disable @typescript-eslint/no-explicit-any -- Chainable server-function and Supabase test doubles. */
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sync: vi.fn(),
  requirePlanEntitlement: vi.fn(),
  single: vi.fn(),
  update: vi.fn(),
  workspace: false,
  publicCanvas: vi.fn(),
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
vi.mock("@tanstack/react-start/server", () => ({ getRequestHost: () => "" }));
vi.mock("./profile.functions", () => ({ loadPublicCreatorPage: mocks.publicCanvas }));
vi.mock("./request-security.server", () => ({ enforceRequestRateLimit: vi.fn() }));
vi.mock("./public-booking-calendar-cache.server", () => ({
  clearPublicBookingCalendarCache: vi.fn(),
  publicBookingCalendarCacheKey: (username: string) => username,
  readPublicBookingCalendarCache: vi.fn().mockResolvedValue({ hit: false, value: null }),
  writePublicBookingCalendarCache: vi.fn(),
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const query: any = {
        update: (...args: any[]) => {
          mocks.update(...args);
          return query;
        },
        eq: () => query,
        select: () => query,
        order: () => query,
        limit: () => query,
        neq: () => query,
        maybeSingle: async () => ({ data: null, error: null }),
        single: () =>
          mocks.workspace && table === "profiles"
            ? Promise.resolve({
                data: {
                  username: "owner",
                  calendar_page_enabled: true,
                  booking_onboarded_at: "2026-09-01",
                },
                error: null,
              })
            : mocks.single(),
        then: (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve),
      };
      return query;
    },
  },
}));
vi.mock("./pages.functions", () => ({ setSystemPageVisibility: mocks.sync }));
vi.mock("./plan.server", () => ({ requirePlanEntitlement: mocks.requirePlanEntitlement }));

import {
  getBookingWorkspace,
  getPublicBookingCalendar,
  renamePublicCalendarPage,
  setPublicCalendarPage,
} from "./booking.functions";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePlanEntitlement.mockResolvedValue(undefined);
  mocks.sync.mockReset().mockResolvedValue({});
  mocks.workspace = false;
});

it("retries enabled Calendar row reconciliation after onboarding has completed", async () => {
  mocks.workspace = true;
  mocks.sync.mockRejectedValueOnce(new Error("page write failed"));
  await expect(getBookingWorkspace()).rejects.toThrow("page write failed");
  await expect(getBookingWorkspace()).resolves.toMatchObject({ publicCalendar: { enabled: true } });
  expect(mocks.sync).toHaveBeenCalledTimes(2);
  expect(mocks.sync).toHaveBeenLastCalledWith("authenticated-client", "owner", "calendar", true);
});

it.each([true, false])("syncs calendar visibility %s after its feature flag", async (enabled) => {
  mocks.single.mockResolvedValue({
    data: { username: "owner", calendar_page_enabled: enabled, calendar_page_name: "Book time" },
    error: null,
  });
  await expect(setPublicCalendarPage({ data: { enabled } })).resolves.toEqual({
    enabled,
    username: "owner",
  });
  expect(mocks.sync).toHaveBeenCalledWith("authenticated-client", "owner", "calendar", enabled);
});

it("renames a hidden calendar without enabling it", async () => {
  mocks.single.mockResolvedValue({
    data: { calendar_page_name: "Office hours", calendar_page_enabled: false },
    error: null,
  });
  await renamePublicCalendarPage({ data: { name: "Office hours" } });
  expect(mocks.sync).toHaveBeenCalledWith(
    "authenticated-client",
    "owner",
    "calendar",
    false,
    "Office hours",
  );
});

it("does not sync after a failed flag mutation or bypass a plan gate", async () => {
  mocks.single.mockResolvedValue({ data: null, error: { message: "write failed" } });
  await expect(setPublicCalendarPage({ data: { enabled: true } })).rejects.toThrow("write failed");
  mocks.requirePlanEntitlement.mockRejectedValue(new Error("Upgrade"));
  await expect(setPublicCalendarPage({ data: { enabled: true } })).rejects.toThrow("Upgrade");
  expect(mocks.sync).not.toHaveBeenCalled();
});

it("omits unlisted sessions from every public Calendar collection while retaining listed sessions", async () => {
  const item = (id: string, visibility: string) => ({
    key: `session:${id}`,
    kind: "session",
    data: {
      id,
      slug: id,
      title: id,
      settings: { calendarVisibility: visibility },
      durationMinutes: 30,
      priceLabel: "Free",
    },
  });
  mocks.publicCanvas.mockResolvedValue({
    notFound: false,
    page: { id: "calendar" },
    profile: { username: "creator" },
    systemItems: [item("listed-session", "listed"), item("hidden-session", "unlisted")],
  });
  const result = await getPublicBookingCalendar({ data: { username: "creator" } });
  expect(result?.sessions.map((session: { id: string }) => session.id)).toEqual(["listed-session"]);
  expect(result?.systemItems.map((session) => session.data.id)).toEqual(["listed-session"]);
  expect(result?.domainData.sessions.map((session: { id: string }) => session.id)).toEqual([
    "listed-session",
  ]);
  expect(JSON.stringify(result)).not.toContain("hidden-session");
});
