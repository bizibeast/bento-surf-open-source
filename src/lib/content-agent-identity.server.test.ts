import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  thread: { id: "thread", user_id: "workspace", title: "New conversation", kind: "agent" },
  brief: null as null | { items: Array<Record<string, unknown>> },
  generate: vi.fn(),
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
    gte: () => query,
    lte: () => query,
    range: () => query,
    limit: () => query,
    textSearch: () => query,
    delete: () => query,
    in: () => query,
    maybeSingle: async () => ({
      data:
        table === "content_agent_threads"
          ? storage.thread
          : table === "creator_content_profiles" && storage.brief
            ? { niche_keywords: ["creator tools"], language: "en", region: "global" }
            : table === "content_trend_briefs"
              ? storage.brief
              : null,
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
  runAiJson: async (request: unknown) => {
    storage.generate(request);
    return { value: { action: "research", message: "Ready", cards: [] } };
  },
}));
import { runContentAgentTurn } from "./content-agent.server";

beforeEach(() => {
  storage.thread.title = "New conversation";
  storage.thread.kind = "agent";
  storage.brief = null;
  storage.generate.mockClear();
});
describe("named agent title persistence", () => {
  it("includes fresh Discover evidence in a normal chat without saved recommendations", async () => {
    storage.brief = {
      items: [
        {
          canonicalUrl: "https://example.com/new-creator-tool",
          title: "Creator platform launches a new publishing tool",
          summary:
            "The platform announced a publishing tool that lets creators prepare content together and review it before it is shared.",
          sourceName: "Example News",
          publishedAt: new Date().toISOString(),
          kind: "rss",
        },
      ],
    };
    await runContentAgentTurn({
      userId: "workspace",
      threadId: "thread",
      text: "What is new in creator tools?",
    });
    const context = storage.generate.mock.calls[0][0].input.context;
    expect(context.recommendations).toEqual([
      expect.objectContaining({
        sourceUrl: "https://example.com/new-creator-tool",
        sourceName: "Example News",
        sourcePublishedAt: storage.brief.items[0].publishedAt,
      }),
    ]);
    expect(context.currentTime).toEqual(expect.any(String));
  });
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
