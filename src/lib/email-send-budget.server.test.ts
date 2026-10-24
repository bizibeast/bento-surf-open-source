import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import migration from "../../supabase/migrations/20261023060000_resend_shared_daily_budget.sql?raw";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: mocks.from,
    rpc: mocks.rpc,
    auth: { admin: { getUserById: vi.fn() } },
  },
}));

vi.mock("./customer-library-magic-link.server", () => ({
  issueCustomerLibraryMagicLinkForEmail: vi.fn(),
}));

import {
  EmailBudgetDeferred,
  nextUtcDayStart,
  recordResendQuota,
  reserveEmailSend,
  resendQuotaExceeded,
  resendQuotaFromHeaders,
} from "./email-send-budget.server";
import { processEmailOutbox } from "./email.server";
import { weeklyDigestEventKey } from "./weekly-digest";

type Row = {
  id: string;
  event_key: string;
  event_type: string;
  category: "marketing" | "transactional";
  recipient_email: string;
  recipient_name: string | null;
  user_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  status: string;
  available_at: string;
  sent_at?: string;
  last_error?: string | null;
};

/**
 * Mirrors reserve_email_send / record_resend_quota from the migration:
 * one shared day total, marketing stops at 60, transactional at 90 (10 kept for Auth).
 */
function fakeBudget(policy = { daily: 100, authReserve: 10, marketingCeiling: 60 }) {
  const usage = { marketing: 0, transactional: 0, untracked: 0 };
  const used = () => usage.marketing + usage.transactional + usage.untracked;
  return {
    usage,
    used,
    reserve(category: "marketing" | "transactional") {
      const cap =
        category === "marketing" ? policy.marketingCeiling : policy.daily - policy.authReserve;
      if (used() >= cap) {
        return { allowed: false, reason: "daily", retry_at: "2026-10-27T00:00:00+00:00" };
      }
      usage[category] += 1;
      return { allowed: true };
    },
    record(daily: number | null) {
      if (daily == null) return;
      usage.untracked = Math.max(usage.untracked, daily - usage.marketing - usage.transactional);
    },
  };
}

const now = new Date("2026-10-26T09:01:00.000Z");
let outbox: Map<string, Row>;
let budget: ReturnType<typeof fakeBudget>;
let resendCalls: string[];
let providerDailyQuota: number | null;
let providerQuotaError: boolean;

function addRow(row: Partial<Row> & Pick<Row, "id" | "event_key" | "event_type" | "category">) {
  outbox.set(row.id, {
    recipient_email: `${row.id}@gmail.com`,
    recipient_name: null,
    user_id: "99999999-9999-4999-8999-999999999999",
    payload: {},
    attempts: 0,
    status: "pending",
    available_at: now.toISOString(),
    ...row,
  });
}

function digestRow(index: number) {
  addRow({
    id: `digest-${index}`,
    event_key: weeklyDigestEventKey(`user-${index}`, "2026-10-26"),
    event_type: "weekly_digest",
    category: "marketing",
    payload: {
      views: 3,
      clicks: 1,
      sales: 0,
      pages: [{ username: `u${index}`, views: 3, clicks: 1 }],
    },
  });
}

function transactionalRow(index: number) {
  addRow({
    id: `welcome-${index}`,
    event_key: `creator-welcome:${index}`,
    event_type: "creator_welcome",
    category: "transactional",
    payload: { username: `creator${index}` },
  });
}

/** Claims due rows like claim_email_outbox: transactional first, then oldest. */
function claim(limit: number) {
  const due = [...outbox.values()]
    .filter((row) => row.status === "pending" && Date.parse(row.available_at) <= Date.now())
    .sort(
      (left, right) =>
        Number(left.category !== "transactional") - Number(right.category !== "transactional"),
    )
    .slice(0, limit);
  for (const row of due) {
    row.status = "processing";
    row.attempts += 1;
  }
  return due.map((row) => ({ ...row }));
}

function emailOutboxTable() {
  let patch: Record<string, unknown> = {};
  const builder: Record<string, unknown> = {
    update: vi.fn((values: Record<string, unknown>) => {
      patch = values;
      return builder;
    }),
    eq: vi.fn((_column: string, id: string) => {
      const row = outbox.get(id);
      if (row) Object.assign(row, patch);
      return Promise.resolve({ error: null });
    }),
  };
  return builder;
}

function emptyTable() {
  const result = { data: null, error: null };
  const builder: Record<string, unknown> = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn().mockResolvedValue(result),
  };
  return builder;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  outbox = new Map();
  budget = fakeBudget();
  resendCalls = [];
  providerDailyQuota = null;
  providerQuotaError = false;
  process.env.EMAIL_DELIVERY_MODE = "production";
  process.env.RESEND_API_KEY = "resend-key";
  process.env.RESEND_FROM_EMAIL = "Bento <hello@example.com>";
  process.env.EMAIL_SIGNING_SECRET = "a-secure-email-signing-secret-123456";
  process.env.RESEND_MIN_INTERVAL_MS = "0";
  mocks.from.mockImplementation((table: string) =>
    table === "email_outbox" ? emailOutboxTable() : emptyTable(),
  );
  mocks.rpc.mockImplementation((name: string, input: Record<string, unknown>) => {
    if (name === "claim_email_outbox") {
      return Promise.resolve({ data: claim(Number(input.p_limit)), error: null });
    }
    if (name === "reserve_email_send") {
      return Promise.resolve({
        data: budget.reserve(input.p_category as "marketing"),
        error: null,
      });
    }
    if (name === "record_resend_quota") {
      budget.record(input.p_daily_used as number | null);
      return Promise.resolve({ data: null, error: null });
    }
    if (name === "update_audience_campaign_recipient_status") {
      return Promise.resolve({ data: 1, error: null });
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  mocks.fetch.mockImplementation((_url: string, init: RequestInit) => {
    const key = (init.headers as Record<string, string>)["idempotency-key"]!;
    if (providerQuotaError) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ name: "daily_quota_exceeded", message: "Daily quota reached." }),
          {
            status: 429,
          },
        ),
      );
    }
    resendCalls.push(key);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (providerDailyQuota !== null) headers["x-resend-daily-quota"] = String(providerDailyQuota);
    return Promise.resolve(
      new Response(JSON.stringify({ id: `resend-${key}` }), { status: 200, headers }),
    );
  });
  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const name of [
    "EMAIL_DELIVERY_MODE",
    "RESEND_API_KEY",
    "RESEND_FROM_EMAIL",
    "EMAIL_SIGNING_SECRET",
    "RESEND_MIN_INTERVAL_MS",
  ]) {
    Reflect.deleteProperty(process.env, name);
  }
});

describe("shared Resend daily cap", () => {
  it("stops marketing at the ceiling and holds the rest for the next UTC day", async () => {
    for (let index = 0; index < 80; index += 1) digestRow(index);
    await processEmailOutbox(100);

    expect(resendCalls).toHaveLength(60);
    const held = [...outbox.values()].filter((row) => row.status === "pending");
    expect(held).toHaveLength(20);
    for (const row of held) {
      expect(row.available_at).toBe("2026-10-27T00:00:00.000Z");
      // The attempt is returned, so the cap never turns into a failed email.
      expect(row.attempts).toBe(0);
    }
    expect(budget.reserve("marketing").allowed).toBe(false);
  });

  it("keeps room for transactional mail after marketing is capped, and never touches the Auth reserve", async () => {
    for (let index = 0; index < 70; index += 1) digestRow(index);
    await processEmailOutbox(100);
    for (let index = 0; index < 40; index += 1) transactionalRow(index);
    await processEmailOutbox(100);

    const sentTransactional = resendCalls.filter((key) => key.startsWith("creator-welcome:"));
    expect(resendCalls.filter((key) => key.startsWith("weekly-digest:"))).toHaveLength(60);
    expect(sentTransactional).toHaveLength(30);
    expect(budget.used()).toBe(90);
  });

  it("counts every category toward one total, so mixed traffic can never pass 90 worker sends", async () => {
    for (let index = 0; index < 50; index += 1) transactionalRow(index);
    for (let index = 0; index < 50; index += 1) digestRow(index);
    await processEmailOutbox(100);
    expect(resendCalls.length).toBeLessThanOrEqual(90);
    // Transactional went first: 50 sent, then marketing filled to the 60 ceiling.
    expect(resendCalls.filter((key) => key.startsWith("creator-welcome:"))).toHaveLength(50);
    expect(resendCalls.filter((key) => key.startsWith("weekly-digest:"))).toHaveLength(10);
  });

  it("counts mail Resend reports that the worker did not send, such as Auth SMTP", async () => {
    providerDailyQuota = 55;
    for (let index = 0; index < 10; index += 1) digestRow(index);
    await processEmailOutbox(100);
    // Resend reports 55 used including our first send, so 54 came from elsewhere
    // and marketing gets 6 sends in total before the shared day reaches 60.
    expect(resendCalls).toHaveLength(6);
    expect(budget.used()).toBe(60);
  });

  it("treats a Resend 429 quota error as held until the reset, not as a failed attempt", async () => {
    providerQuotaError = true;
    transactionalRow(1);
    digestRow(1);
    await processEmailOutbox(100);
    expect(resendCalls).toEqual([]);
    for (const row of outbox.values()) {
      expect(row.status).toBe("pending");
      expect(row.attempts).toBe(0);
      expect(row.available_at).toBe("2026-10-27T00:00:00.000Z");
    }
    expect(budget.used()).toBeGreaterThanOrEqual(100);
  });

  it("sends a held digest exactly once after the rollover", async () => {
    for (let index = 0; index < 65; index += 1) digestRow(index);
    await processEmailOutbox(100);
    expect(resendCalls).toHaveLength(60);

    // Next UTC day: fresh counter, held rows become due.
    vi.setSystemTime(new Date("2026-10-27T00:05:00.000Z"));
    budget = fakeBudget();
    await processEmailOutbox(100);
    await processEmailOutbox(100);

    expect(resendCalls).toHaveLength(65);
    expect(new Set(resendCalls).size).toBe(65);
    expect([...outbox.values()].every((row) => row.status === "sent")).toBe(true);
  });

  it("drops a digest from an earlier week instead of sending it late", async () => {
    addRow({
      id: "stale",
      event_key: weeklyDigestEventKey("user-stale", "2026-10-19"),
      event_type: "weekly_digest",
      category: "marketing",
      payload: {
        views: 3,
        clicks: 0,
        sales: 0,
        pages: [{ username: "stale", views: 3, clicks: 0 }],
      },
    });
    await processEmailOutbox(10);
    expect(resendCalls).toEqual([]);
    expect(outbox.get("stale")?.status).toBe("suppressed");
    expect(budget.used()).toBe(0);
  });
});

describe("email send budget client", () => {
  it("fails closed with a short retry when the budget cannot be read", async () => {
    const client = { rpc: async () => ({ data: null, error: { message: "down" } }) };
    const error = await reserveEmailSend("transactional", { client, now }).catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(EmailBudgetDeferred);
    expect(error.reason).toBe("unavailable");
    expect(error.retryAt).toBe("2026-10-26T09:06:00.000Z");
  });

  it("defers to the next UTC midnight when the daily cap is reached", async () => {
    const client = {
      rpc: async () => ({ data: { allowed: false, reason: "daily" }, error: null }),
    };
    const error = await reserveEmailSend("marketing", { client, now }).catch((caught) => caught);
    expect(error.retryAt).toBe(nextUtcDayStart(now));
    expect(nextUtcDayStart(new Date("2026-10-26T23:59:59.000Z"))).toBe("2026-10-27T00:00:00.000Z");
  });

  it("reads Resend quota headers and quota errors", async () => {
    expect(
      resendQuotaFromHeaders(
        new Headers({ "x-resend-daily-quota": "42", "x-resend-monthly-quota": "130" }),
      ),
    ).toEqual({ daily: 42, monthly: 130 });
    expect(resendQuotaFromHeaders(new Headers())).toEqual({ daily: null, monthly: null });
    expect(resendQuotaExceeded(429, { name: "daily_quota_exceeded" })).toBe("daily");
    expect(resendQuotaExceeded(429, { name: "monthly_quota_exceeded" })).toBe("monthly");
    expect(resendQuotaExceeded(429, { name: "rate_limit_exceeded" })).toBeNull();
    expect(resendQuotaExceeded(500, { name: "daily_quota_exceeded" })).toBeNull();
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    await expect(
      recordResendQuota({ daily: null, monthly: null }, { client: { rpc } }),
    ).resolves.toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("shared budget migration", () => {
  it("serializes reservations and counts every category toward one total", () => {
    expect(migration).toContain("where id for update");
    expect(migration).toContain("usage.marketing + usage.transactional + usage.untracked_daily");
    expect(migration).toContain("day_cap := policy.marketing_daily_ceiling");
    expect(migration).toContain("day_cap := policy.daily_limit - policy.auth_reserve");
    expect(migration).toContain("values (true, 100, 3000, 10, 60, 2500)");
    expect(migration).toContain("(now() at time zone 'utc')::date");
  });

  it("exposes the budget functions only to the service role", () => {
    for (const signature of ["reserve_email_send(text)", "record_resend_quota(integer, integer)"]) {
      expect(migration).toContain(
        `revoke all on function public.${signature} from public, anon, authenticated`,
      );
      expect(migration).toContain(`grant execute on function public.${signature} to service_role`);
    }
  });
});
