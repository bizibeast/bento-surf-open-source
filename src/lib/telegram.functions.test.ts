import { beforeEach, describe, expect, it, vi } from "vitest";

const connectionId = "33333333-3333-4333-8333-333333333333";
const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  eq: vi.fn(),
  requireContent: vi.fn(),
  rateLimit: vi.fn(),
}));

function queryFor(table: string) {
  const query: Record<string, unknown> = {};
  for (const method of ["delete", "select", "lt"] as const) query[method] = vi.fn(() => query);
  query.eq = vi.fn((column: string, value: unknown) => {
    mocks.eq(table, column, value);
    return query;
  });
  query.insert = vi.fn((value: unknown) => {
    mocks.insert(table, value);
    return Promise.resolve({ error: null });
  });
  query.maybeSingle = vi.fn(async () => ({ data: { id: connectionId }, error: null }));
  query.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data: null, error: null }).then(resolve);
  return query;
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
  supabaseAdmin: { from: (table: string) => queryFor(table) },
}));
vi.mock("./content-access.server", () => ({ requireContentWorkspace: mocks.requireContent }));
vi.mock("./request-security.server", () => ({ enforceRequestRateLimit: mocks.rateLimit }));

import { beginTelegramConnection, disconnectTelegramConnection } from "./telegram.functions";

describe("Telegram connection functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = "123456:bot-token";
    process.env.TELEGRAM_BOT_USERNAME = "BentoAgentBot";
    process.env.TELEGRAM_WEBHOOK_SECRET = "a-secure-webhook-secret";
  });

  it("creates a ten-minute creator-bound Telegram start link", async () => {
    const result = await beginTelegramConnection();
    expect(result.url).toMatch(/^https:\/\/t\.me\/BentoAgentBot\?start=[0-9a-f-]{36}$/i);
    expect(mocks.insert).toHaveBeenCalledWith(
      "content_connection_states",
      expect.objectContaining({ user_id: "owner", provider: "telegram" }),
    );
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      "EXPENSIVE_API_RATE_LIMITER",
      "telegram-connect",
      "owner",
    );
  });

  it("disconnects only the authenticated creator's Telegram connection", async () => {
    await disconnectTelegramConnection({ data: { id: connectionId } });
    expect(mocks.eq).toHaveBeenCalledWith("content_connections", "id", connectionId);
    expect(mocks.eq).toHaveBeenCalledWith("content_connections", "user_id", "owner");
    expect(mocks.eq).toHaveBeenCalledWith("content_connections", "provider", "telegram");
  });
});
