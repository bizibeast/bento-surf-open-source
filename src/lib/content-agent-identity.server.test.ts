import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  thread: { id: "thread", user_id: "workspace", title: "New conversation", kind: "agent" },
}));
// In-memory database adapter applies update predicates so assertions verify the
// resulting title through the production turn, not calls on a query spy.
function from(table: string) {
  const filters: Array<[string, unknown]> = [];
  let patch: Record<string, unknown> | undefined;
  let insert: Record<string, unknown> | undefined;
  const query = {
    select: () => query,
    eq: (key: string, value: unknown) => {
      filters.push([key, value]);
      return query;
    },
    update: (value: Record<string, unknown>) => {
      patch = value;
      return query;
    },
    insert: (value: Record<string, unknown>) => {
      insert = value;
      return query;
    },
    order: () => query,
    is: () => query,
    gt: () => query,
    lte: () => query,
    range: () => query,
    limit: () => query,
    textSearch: () => query,
    delete: () => query,
    in: () => query,
    maybeSingle: async () => ({
      data: table === "content_agent_threads" ? storage.thread : null,
      error: null,
    }),
    single: async () => ({ data: { id: insert ? "saved-message" : "thread" }, error: null }),
    then: (resolve: (value: unknown) => unknown) => {
      if (
        table === "content_agent_threads" &&
        patch &&
        filters.every(
          ([key, value]) => storage.thread[key as keyof typeof storage.thread] === value,
        )
      )
        Object.assign(storage.thread, patch);
      return Promise.resolve({ data: [], error: null }).then(resolve);
    },
  };
  return query;
}
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from } }));
vi.mock("./content-access.server", () => ({ requireContentWorkspace: vi.fn() }));
vi.mock("./content-existing-sources.server", () => ({
  loadExistingContentSources: async () => [],
}));
vi.mock("./content-business-context.server", () => ({
  loadContentBusinessContext: async () => ({}),
}));
vi.mock("./ai-json.server", () => ({
  runAiJson: async () => ({ value: { action: "research", message: "Ready", cards: [] } }),
}));
import { runContentAgentTurn } from "./content-agent.server";

beforeEach(() => {
  storage.thread.title = "New conversation";
  storage.thread.kind = "agent";
});
describe("named agent title persistence", () => {
  it("preserves a creator's agent name even when it equals the ordinary-chat placeholder", async () => {
    await runContentAgentTurn({ userId: "workspace", threadId: "thread", text: "Plan my week" });
    expect(storage.thread.title).toBe("New conversation");
  });
  it("still titles an ordinary chat from its first user message", async () => {
    storage.thread.kind = "chat";
    await runContentAgentTurn({ userId: "workspace", threadId: "thread", text: "Plan my week" });
    expect(storage.thread.title).toBe("Plan my week");
  });
});
