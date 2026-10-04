import { describe, expect, it, vi } from "vitest";
import {
  contentAgentThreadTitle,
  generateContentAgentResult,
  inferInitialBrainSuggestions,
  runContentAgentTurn,
  sampleBrainSourcePosts,
  type ContentAgentDependencies,
} from "./content-agent.server";

const threadId = "11111111-1111-4111-8111-111111111111";

function dependencies(): ContentAgentDependencies {
  return {
    loadContext: vi.fn().mockResolvedValue({
      threadId,
      brain: [
        {
          id: "brain",
          kind: "story",
          title: "Launch",
          content: "Confirmed launch story",
          status: "confirmed",
          locked: false,
        },
      ],
      recommendations: [
        {
          title: "Creator tools update",
          sourceUrl: "https://publisher.com/story",
          sourcePublishedAt: "2026-09-18T08:00:00.000Z",
          feedback: "saved",
        },
      ],
      sources: [
        {
          provider: "notion",
          externalItemId: "page-1",
          type: "page",
          title: "Launch plan",
          text: "Launch next week.",
          sourceUrl: "https://notion.so/page-1",
          occurredAt: "2026-09-19T10:00:00.000Z",
          metadata: {},
        },
      ],
      scheduler: { connections: [], slots: [] },
      performance: { bestFormat: "text" },
      feedback: [],
    }),
    saveMessage: vi.fn().mockResolvedValue("message-id"),
    generate: vi.fn().mockResolvedValue({
      action: "research",
      message: "One current source is relevant.",
      cards: [
        {
          type: "source",
          cardId: "source-1",
          title: "Creator tools update",
          url: "https://publisher.com/story",
          sourceName: "Publisher",
          publishedAt: "2026-09-18T08:00:00.000Z",
          summary: "Summary",
        },
      ],
    }),
    cleanupMessages: vi.fn().mockResolvedValue(undefined),
    loadBrainSeed: vi.fn().mockResolvedValue({ existing: [], insights: [] }),
    generateBrainSuggestions: vi.fn().mockResolvedValue([]),
    saveBrainSuggestions: vi.fn().mockResolvedValue([]),
  };
}

describe("content Agent server", () => {
  it("samples history across platforms instead of letting the newest platform hide every story", () => {
    const posts = Array.from({ length: 100 }, (_, index) => ({
      provider: "threads",
      remote_post_id: `t-${index}`,
      engagements: index,
      caption: "A post",
    }));
    const samples = sampleBrainSourcePosts([
      ...posts,
      {
        provider: "instagram",
        remote_post_id: "i-1",
        engagements: 4,
        caption: "An older founder story",
      },
    ]);
    expect(samples.some((post) => post.remote_post_id === "i-1")).toBe(true);
    expect(samples.some((post) => post.remote_post_id === "t-99")).toBe(true);
    expect(samples.length).toBeLessThanOrEqual(61);
  });
  it("persists only memories with evidence in the user's message", async () => {
    const deps = dependencies();
    deps.saveMemories = vi.fn().mockResolvedValue(1);
    vi.mocked(deps.generate).mockResolvedValue({
      action: "answer",
      message: "Understood.",
      cards: [],
      memories: [
        { title: "Work", sourceQuote: "I build creator tools." },
        { title: "Invented", sourceQuote: "I have a million followers." },
      ],
    });
    const result = await runContentAgentTurn(
      { userId: "creator-id", text: "I build creator tools." },
      deps,
    );
    expect(deps.saveMemories).toHaveBeenCalledWith("creator-id", "message-id", [
      { title: "Work", sourceQuote: "I build creator tools." },
    ]);
    expect(result.memoriesSaved).toBe(1);
    await runContentAgentTurn(
      { userId: "creator-id", text: "Don't remember this. I build creator tools." },
      deps,
    );
    expect(deps.saveMemories).toHaveBeenLastCalledWith("creator-id", "message-id", []);
  });

  it("retains a saved reply when memory persistence fails", async () => {
    const deps = dependencies();
    deps.saveMemories = vi.fn().mockRejectedValue(new Error("Database unavailable"));
    const result = await runContentAgentTurn(
      { userId: "creator-id", text: "Research my niche today" },
      deps,
    );
    expect(result.memoryWarning).toContain("reply was saved");
    expect(deps.saveMessage).toHaveBeenCalledTimes(2);
  });
  it("turns the first user message into a concise conversation title", () => {
    expect(contentAgentThreadTitle("  Plan   a week of LinkedIn posts  ")).toBe(
      "Plan a week of LinkedIn posts",
    );
    expect(contentAgentThreadTitle("a".repeat(100))).toBe(`${"a".repeat(69)}…`);
  });

  it("requests the strict Agent JSON schema from the AI provider", async () => {
    const ai = {
      run: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({ action: "answer", message: "One idea", cards: [] }),
            },
          },
        ],
      }),
    };
    await expect(generateContentAgentResult("{}", { AI: ai })).resolves.toMatchObject({
      action: "answer",
      message: "One idea",
    });
    expect(ai.run).toHaveBeenCalledWith(
      "@cf/openai/gpt-oss-20b",
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining(
              '"request" field is the newest user turn and must be answered directly',
            ),
          }),
        ]),
        response_format: expect.objectContaining({
          type: "json_schema",
          json_schema: expect.objectContaining({
            strict: true,
            schema: expect.objectContaining({
              required: ["action", "message", "cards", "memories"],
            }),
          }),
        }),
      }),
      undefined,
    );
  });

  it("states the top-level Agent envelope when a provider ignores response_format", async () => {
    const ai = {
      run: vi.fn(async (_model: string, input: Record<string, unknown>) => {
        const messages = input.messages as Array<{ role: string; content: string }>;
        const system = messages.find((message) => message.role === "system")?.content || "";
        const payload = system.includes(
          'top-level keys "action", "message", "cards", and "memories"',
        )
          ? { action: "answer", message: "One idea", cards: [] }
          : { postIdea: "One idea" };
        return { choices: [{ message: { content: JSON.stringify(payload) } }] };
      }),
    };
    await expect(generateContentAgentResult("{}", { AI: ai })).resolves.toMatchObject({
      action: "answer",
      message: "One idea",
      cards: [],
    });
  });

  it("runs one bounded turn with creator-owned context and persists validated cards", async () => {
    const deps = dependencies();
    const result = await runContentAgentTurn(
      { userId: "creator-id", threadId, text: "Research my niche today" },
      deps,
    );
    expect(deps.loadContext).toHaveBeenCalledWith(
      "creator-id",
      threadId,
      "Research my niche today",
    );
    expect(deps.generate).toHaveBeenCalledWith(
      expect.stringContaining("https://publisher.com/story"),
    );
    expect(deps.generate).toHaveBeenCalledWith(
      expect.stringContaining("BEGIN UNTRUSTED SOURCE MATERIAL"),
    );
    expect(deps.saveMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ userId: "creator-id", role: "user" }),
    );
    expect(deps.saveMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        role: "assistant",
        payload: expect.objectContaining({ action: "research" }),
      }),
    );
    expect(deps.cleanupMessages).toHaveBeenCalledWith("creator-id", threadId, 100);
    expect(result.messageId).toBe("message-id");
    expect(result.result.cards[0]).toMatchObject({ url: "https://publisher.com/story" });
  });

  it("rejects malformed model output before persistence", async () => {
    const deps = dependencies();
    vi.mocked(deps.generate).mockResolvedValue({
      action: "publish_now",
      message: "Done",
      cards: [],
    });
    await expect(
      runContentAgentTurn({ userId: "creator-id", threadId, text: "Post now" }, deps),
    ).rejects.toThrow();
    expect(deps.saveMessage).toHaveBeenCalledTimes(1);
  });

  it("creates suggested Brain items only from that creator's recent posts", async () => {
    const deps = dependencies();
    vi.mocked(deps.loadBrainSeed).mockResolvedValue({
      existing: [],
      insights: [
        {
          provider: "linkedin",
          remote_post_id: "post-1",
          caption: "Building Bento taught me to ship narrow versions first.",
          impressions: 10_000,
        },
      ],
    });
    vi.mocked(deps.generateBrainSuggestions).mockResolvedValue([
      {
        kind: "story",
        title: "Ship narrow versions first",
        content: "Building Bento reinforced a bias toward narrow first releases.",
        provenance: "social_post",
        sourceRef: "linkedin:post-1",
      },
    ]);
    await inferInitialBrainSuggestions("creator-id", deps);
    expect(deps.loadBrainSeed).toHaveBeenCalledWith("creator-id");
    expect(deps.saveBrainSuggestions).toHaveBeenCalledWith(
      "creator-id",
      expect.arrayContaining([expect.objectContaining({ status: "suggested", locked: false })]),
    );
  });
});
