import { expect, it, vi } from "vitest";

const rows: Record<string, unknown[]> = {
  social_connections: [],
  booking_calendar_connections: [],
  booking_fathom_connections: [],
  content_connections: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      provider: "telegram",
      external_account_id: "99",
      display_name: "@creator",
      status: "active",
      scopes: ["private_chat"],
      metadata: { username: "creator" },
      last_attempt_at: null,
      last_success_at: "2026-09-19T00:00:00.000Z",
      last_error: null,
      created_at: "2026-09-19T00:00:00.000Z",
      access_token_ciphertext: "must-not-leak",
    },
  ],
};

function queryFor(table: string) {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order"] as const) query[method] = vi.fn(() => query);
  query.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data: rows[table] || [], error: null }).then(resolve);
  return query;
}

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const fn: Record<string, unknown> = {};
    fn.middleware = () => fn;
    fn.handler = (handler: (input: { context: { userId: string } }) => unknown) => () =>
      handler({ context: { userId: "owner" } });
    return fn;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (table: string) => queryFor(table) },
}));
vi.mock("./booking-google.server", () => ({ googleCalendarReady: () => true }));
vi.mock("./booking-fathom.server", () => ({ fathomReady: () => true }));
vi.mock("./social-oauth.functions", () => ({ socialProviderReadiness: () => ({}) }));
vi.mock("./telegram.server", () => ({
  telegramReady: () => true,
  telegramBotUsername: () => "BentoAgentBot",
}));
vi.mock("./notion-content.server", () => ({ notionReady: () => true }));
vi.mock("./granola-content.server", () => ({ granolaReady: () => true }));
vi.mock("./github-content.server", () => ({ githubReady: () => true }));
vi.mock("./slack-content.server", () => ({ slackReady: () => true }));

import { getIntegrationOverview } from "./integrations.functions";

it("returns safe Telegram connection state without credentials", async () => {
  const result = await getIntegrationOverview();
  expect(result.contentReadiness).toEqual({
    telegram: true,
    notion: true,
    granola: true,
    github: true,
    slack: true,
  });
  expect(result.contentProviderMetadata).toEqual({ telegramUsername: "BentoAgentBot" });
  expect(result.contentConnections).toEqual([
    expect.objectContaining({
      provider: "telegram",
      externalAccountId: "99",
      displayName: "@creator",
      status: "active",
    }),
  ]);
  expect(JSON.stringify(result)).not.toContain("must-not-leak");
});
