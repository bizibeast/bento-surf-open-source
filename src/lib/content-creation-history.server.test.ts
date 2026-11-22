import { beforeEach, expect, it, vi } from "vitest";
const store = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, unknown>[]>,
  scopes: [] as string[],
}));
vi.mock("./content-studio.server", () => ({ requireStudioWorkspace: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from(table: string) {
      const filters: ((r: Record<string, unknown>) => boolean)[] = [];
      const q = {
        select: () => q,
        order: () => q,
        limit: () => q,
        eq(key: string, value: unknown) {
          filters.push((r) => r[key] === value);
          return q;
        },
        in(key: string, values: unknown[]) {
          filters.push((r) => values.includes(r[key]));
          return q;
        },
        gt: () => q,
        or: () => q,
        maybeSingle: async () => ({
          data: (store.rows[table] || []).filter((r) => filters.every((f) => f(r)))[0] || null,
          error: null,
        }),
        then(resolve: (r: unknown) => unknown) {
          return Promise.resolve({
            data: (store.rows[table] || []).filter((r) => filters.every((f) => f(r))),
            error: null,
          }).then(resolve);
        },
      };
      return q;
    },
  },
}));
import { loadContentCreationHistory } from "./content-creation-history.server";
const workspace = "11111111-1111-4111-8111-111111111111";
const entry = "22222222-2222-4222-8222-222222222222";
const message = "33333333-3333-4333-8333-333333333333";
const thread = "44444444-4444-4444-8444-444444444444";
beforeEach(() => {
  store.rows = {
    content_studio_entries: [{ id: entry, workspace_id: workspace }],
    content_reference_drafts: [
      {
        id: entry,
        workspace_id: workspace,
        request_id: "55555555-5555-4555-8555-555555555555",
        input: { prompt: "My original brief" },
      },
    ],
    content_agent_app_actions: [
      {
        id: entry,
        user_id: workspace,
        message_id: message,
        tool_name: "create_content_from_reference",
        status: "completed",
        created_at: "2026-11-22T00:00:00Z",
      },
    ],
    content_agent_messages: [{ id: message, user_id: workspace, thread_id: thread }],
  };
});
it("recovers the real conversation and creative brief from existing owner receipts", async () => {
  const history = await loadContentCreationHistory(workspace, entry);
  expect(history).toMatchObject({
    brief: "My original brief",
    conversationPath: `/content?tab=agent&thread=${thread}`,
    actions: [{ tool: "create_content_from_reference", status: "completed" }],
  });
});
it("refuses a foreign project and omits another owner's message", async () => {
  await expect(
    loadContentCreationHistory("66666666-6666-4666-8666-666666666666", entry),
  ).rejects.toThrow(/unavailable/);
  store.rows.content_agent_messages[0].user_id = "another-workspace";
  expect((await loadContentCreationHistory(workspace, entry)).conversationPath).toBeNull();
});
