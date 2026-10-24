import * as providerBudget from "./provider-budget.server";
import { describe, expect, it, vi } from "vitest";
import { loadAgentAttachments } from "./content-agent-attachments.server";
vi.mock("./content-agent-attachments.server", () => ({
  loadAgentAttachments: vi.fn().mockResolvedValue([]),
}));
import { generateEditorialDraft } from "./content-editorial.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireContentWorkspace } from "./content-access.server";
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: vi.fn() } }));
vi.mock("./content-access.server", () => ({
  requireContentWorkspace: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./content-existing-sources.server", () => ({
  loadExistingContentSources: vi.fn().mockResolvedValue([]),
}));
vi.mock("./content-business-context.server", () => ({
  loadContentBusinessContext: vi.fn().mockResolvedValue({}),
}));
import {
  buildContentStrategy,
  completeContentStrategy,
  contentProfileSchema,
} from "./content-brain";
import {
  loadContentEditorialContext,
  editorialContextFromAgent,
  loadContentRevisionTarget,
  contentAgentThreadTitle,
  generateContentAgentResult,
  generateConnectedBrainSuggestions,
  inferInitialBrainSuggestions,
  runContentAgentTurn,
  sampleBrainSourcePosts,
  type ContentAgentDependencies,
} from "./content-agent.server";

function withStrategies(items: Array<Record<string, unknown>>) {
  const first = items[0];
  return [
    ...items,
    ...(["twitter", "linkedin"] as const).map((platform) => ({
      ...first,
      kind: "strategy",
      title: platform === "twitter" ? "X Strategy" : "LinkedIn Strategy",
      content: buildContentStrategy(platform, contentProfileSchema.parse({}), []),
    })),
  ];
}

function brainReviewResponse(input: { messages: Array<{ role: string; content: string }> }) {
  const payload = JSON.parse(input.messages.find((message) => message.role === "user")!.content);
  return {
    response: JSON.stringify({
      reviews: payload.documents.map((document: { id: string }) => ({
        id: document.id,
        approved: true,
        sourceIds: [payload.sources[0].id],
        issues: [],
      })),
    }),
  };
}

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
  it("passes an attached reference to both the conversational model and the editorial evidence checker", async () => {
    const attachment = {
      id: "00000000-0000-4000-8000-000000000001",
      key: "private/users/creator/agent/brief.txt",
      name: "brief.txt",
      mimeType: "text/plain",
      size: 50,
      mediaId: null,
      url: null,
      extractedText: "The workshop is for new founders on Saturday.",
    };
    vi.mocked(loadAgentAttachments).mockResolvedValueOnce([attachment]);
    const d = dependencies();
    const draft = {
      type: "draft",
      cardId: "draft",
      platform: "linkedin",
      format: "post",
      title: "Workshop",
      body: "A workshop for new founders.",
      sourceUrls: [],
      rationale: "From the brief",
      visualBrief: null,
    };
    vi.mocked(d.generate).mockResolvedValue({
      action: "draft",
      message: "Review this",
      cards: [draft],
    });
    d.generateEditorial = vi
      .fn()
      .mockResolvedValue({ status: "ready", card: draft, issues: [], message: "Ready" });
    await runContentAgentTurn(
      {
        userId: "creator",
        text: "Draft a LinkedIn post from the brief",
        attachmentIds: [attachment.id],
      },
      d,
    );
    expect(
      JSON.parse(vi.mocked(d.generate).mock.calls[0][0]).attachments[0].extractedText,
    ).toContain("Saturday");
    expect(vi.mocked(d.generateEditorial).mock.calls[0][0].sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `attachment:${attachment.id}`,
          text: attachment.extractedText,
        }),
      ]),
    );
    expect(d.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "user",
        payload: { attachments: [expect.objectContaining({ name: "brief.txt", url: null })] },
      }),
    );
  });

  it.each(["idea", "weekly_plan"])(
    "recovers a requested post when the model returns only a %s",
    async (type) => {
      const d = dependencies();
      const card =
        type === "idea"
          ? {
              type,
              cardId: "idea",
              title: "Debugging",
              premise: "Inspect responses",
              format: "post",
              takeaway: "Check the shape",
              sourceUrls: [],
            }
          : {
              type,
              cardId: "plan",
              days: [{ date: "2026-10-14", platform: "linkedin", idea: "Debugging" }],
            };
      vi.mocked(d.generate).mockResolvedValue({
        action: "draft",
        message: "Your post is ready",
        cards: [card],
      });
      d.generateEditorial = vi.fn().mockResolvedValue({
        status: "ready",
        message: "Ready",
        issues: [],
        card: {
          type: "draft",
          cardId: "checked",
          platform: "linkedin",
          format: "post",
          title: "Inspect the response",
          body: "Start by inspecting the response body before debugging the SDK.",
          sourceUrls: [],
          rationale: "A concrete debugging step",
          visualBrief: null,
        },
      });
      const result = await runContentAgentTurn(
        { userId: "creator", text: "Draft one LinkedIn post about debugging" },
        d,
      );
      expect(d.generateEditorial).toHaveBeenCalledWith(
        expect.objectContaining({ platform: "linkedin" }),
        expect.not.objectContaining({ initialDraft: expect.anything() }),
      );
      expect(result.result.cards).toEqual([
        expect.objectContaining({
          type: "draft",
          body: "Start by inspecting the response body before debugging the SDK.",
        }),
      ]);
      vi.mocked(d.generateEditorial).mockResolvedValue({
        status: "needs_input",
        message: "Please share the source",
        reason: "evidence",
        issues: [],
        card: {
          type: "idea",
          cardId: "checked",
          title: "Evidence needed",
          premise: "Verify the claim",
          format: "linkedin/post",
          takeaway: "Please share the source",
          sourceUrls: [],
        },
      });
      const rejected = await runContentAgentTurn(
        { userId: "creator", text: "Draft one LinkedIn post about debugging" },
        d,
      );
      expect(rejected.result.action).toBe("answer");
      expect(rejected.result.message).toBe("Please share the source");
      expect(rejected.result.cards.some((item) => item.type === "draft")).toBe(false);
    },
  );
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
    expect(samples.some((post) => post.remote_post_id === "t-0")).toBe(true);
    expect(samples.length).toBeLessThanOrEqual(61);
  });
  it("uses the best performing posts from the requested platform as voice examples", async () => {
    const context = await dependencies().loadContext("creator");
    context.performance.recentPosts = [
      { provider: "linkedin", remote_post_id: "low", engagements: 1, caption: "Low reach" },
      { provider: "twitter", remote_post_id: "cross", engagements: 900, caption: "X voice" },
      { provider: "linkedin", remote_post_id: "high", engagements: 50, caption: "Top voice" },
    ];
    const editorial = editorialContextFromAgent(context, "A fresh idea", "linkedin");
    expect(editorial.representativePosts?.map((post) => post.id)).toEqual([
      "linkedin:high",
      "linkedin:low",
      "twitter:cross",
    ]);
  });
  it("bounds Brain input and excludes large media metadata from provider requests", async () => {
    const posts = Array.from({ length: 100 }, (_, index) => ({
      provider: index % 2 ? "instagram" : "threads",
      remote_post_id: `p-${index}`,
      caption: "I build creator tools. ".repeat(200),
      remote_post_url: "https://example.com/" + "x".repeat(10000),
      media_sources: [{ url: "x".repeat(100000) }],
      engagements: index,
    }));
    const samples = sampleBrainSourcePosts(posts);
    expect(samples).toHaveLength(24);
    expect(JSON.stringify(samples).length).toBeLessThan(16000);
    expect(
      samples.every((post) => !("media_sources" in post) && !("remote_post_url" in post)),
    ).toBe(true);
    const ai = {
      run: vi.fn().mockResolvedValue({
        response: JSON.stringify({
          suggestions: withStrategies([
            {
              kind: "profile",
              title: "My Human",
              content: "Builds creator tools.",
              provenance: "social_post",
              sourceRef: "post-1",
              tags: [],
              evidence: [{ sourceRef: "post-1", quote: "I build creator tools" }],
            },
          ]),
        }),
      }),
    };
    const generationResponse = await ai.run();
    ai.run
      .mockReset()
      .mockResolvedValueOnce(generationResponse)
      .mockImplementation(async (_model, input) => brainReviewResponse(input));
    await generateConnectedBrainSuggestions(posts, undefined, { AI: ai });
    const input = ai.run.mock.calls[0][1] as Record<string, unknown>;
    expect(input.max_tokens).toBe(6000);
    expect(input.response_format).toEqual({ type: "json_object" });
    const messages = input.messages as Array<{ role: string; content: string }>;
    expect(messages.find((message) => message.role === "system")?.content).toContain(
      '"provenance":"social_post"',
    );
    expect(messages.find((message) => message.role === "user")?.content.length).toBeLessThan(16000);
  });
  it("keeps grounded Brain generation and review on the explicitly selected provider", async () => {
    const item = {
      kind: "profile",
      title: "My Human",
      content: "Builds creator tools.",
      provenance: "social_post",
      sourceRef: "post-1",
      evidence: [{ sourceRef: "post-1", quote: "I build creator tools" }],
    };
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                suggestions: [
                  {
                    ...item,
                    evidence: [{ sourceRef: "post-1", quote: "I raised a million dollars" }],
                  },
                ],
              }),
            },
          },
        ],
      }),
    );
    const ai = {
      run: vi
        .fn()
        .mockResolvedValue({ response: JSON.stringify({ suggestions: withStrategies([item]) }) }),
    };
    const generationResponse = await ai.run();
    ai.run
      .mockReset()
      .mockResolvedValueOnce(generationResponse)
      .mockImplementation(async (_model, input) => brainReviewResponse(input));
    try {
      const result = await generateConnectedBrainSuggestions(
        [
          {
            provider: "threads",
            remote_post_id: "17900000000000001",
            caption: "I build creator tools and share lessons.",
          },
        ],
        undefined,
        { AI_TEXT_PROVIDER: "workers-ai", OPENROUTER_API_KEY: "test-key", AI: ai },
      );
      expect(ai.run).toHaveBeenCalledTimes(2);
      expect(ai.run.mock.calls[0][0]).toBe("@cf/openai/gpt-oss-120b");
      expect(result[0].sourceRef).toBe("threads:17900000000000001");
      expect(result[0].evidence?.[0].sourceRef).toBe("threads:17900000000000001");
    } finally {
      fetcher.mockRestore();
    }
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
      "@cf/openai/gpt-oss-120b",
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

const postCard = {
  type: "draft",
  cardId: "draft",
  platform: "twitter",
  format: "post",
  title: "A lesson",
  body: "Ask one precise question.",
  sourceUrls: [],
  visualBrief: null,
  rationale: "A practical lesson",
};
it("gates supported drafts in ordinary chats and preserves their card identity", async () => {
  const deps = dependencies();
  vi.mocked(deps.generate).mockResolvedValue({
    action: "draft",
    message: "Draft",
    cards: [postCard],
  });
  deps.generateEditorial = vi.fn().mockResolvedValue({
    status: "ready",
    message: "Review",
    issues: [],
    card: { ...postCard, cardId: "editorial-draft", body: "An edited argument." },
  });
  const result = await runContentAgentTurn(
    { userId: "creator", threadId, text: "Draft an X post" },
    deps,
  );
  expect(deps.generateEditorial).toHaveBeenCalledOnce();
  expect(result.result.cards[0]).toMatchObject({ cardId: "draft", body: "An edited argument." });
});
it("named agent offers a video angle while explicit video scripts remain available in ordinary chats", async () => {
  for (const kind of ["agent", "chat"] as const) {
    const deps = dependencies();
    const context = await deps.loadContext("creator", threadId);
    vi.mocked(deps.loadContext).mockResolvedValue({ ...context, threadKind: kind });
    vi.mocked(deps.generate).mockResolvedValue({
      action: "draft",
      message: "Draft",
      cards: [{ ...postCard, platform: "youtube", format: "long_script" }],
    });
    const result = await runContentAgentTurn(
      { userId: "creator", threadId, text: "Write a video script" },
      deps,
    );
    expect(result.result.cards[0].type).toBe(kind === "agent" ? "idea" : "draft");
  }
});
it("drops schedule proposals for rejected drafts", async () => {
  const deps = dependencies();
  vi.mocked(deps.generate).mockResolvedValue({
    action: "schedule_proposal",
    message: "Proposed",
    cards: [
      postCard,
      {
        type: "schedule_proposal",
        cardId: "schedule",
        draftCardId: "draft",
        connectionId: threadId,
        scheduledAt: "2026-10-13T12:00:00Z",
        timezone: "UTC",
      },
    ],
  });
  deps.generateEditorial = vi.fn().mockResolvedValue({
    status: "needs_input",
    issues: [],
    message: "What changed?",
    card: {
      type: "idea",
      cardId: "idea",
      title: "Question",
      premise: "New example",
      format: "twitter/post",
      takeaway: "What changed?",
      sourceUrls: [],
    },
  });
  const result = await runContentAgentTurn(
    { userId: "creator", threadId, text: "Schedule an X post" },
    deps,
  );
  expect(result.result.cards.map((card) => card.type)).toEqual(["idea"]);
  expect(result.result.message).toBe("What changed?");
});

it("loads workspace drafts, historical dates and cross-chat rejection feedback without creating a chat", async () => {
  const queries: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  const from = vi.spyOn(supabaseAdmin, "from").mockImplementation(((table: string) => {
    const query = { table, filters: [] as Array<[string, unknown]> };
    queries.push(query);
    const rows: Record<string, unknown[]> = {
      creator_brain_items: [],
      creator_content_recommendations: [
        {
          id: "fiction",
          title: "A Rich CEO Humiliated a Courier… Then Learned Who Really Owned the Company!",
          summary: "A ruthless tech founder arrives expecting a $20 million investment.",
          source_url: "https://example.com/fiction",
          feedback: "saved",
        },
        {
          id: "relevant",
          title: "A startup founder shares customer research",
          summary: "Lessons from interviewing customers about their product.",
          source_url: "https://example.com/relevant",
          feedback: "pending",
        },
      ],
      social_connections: [],
      creator_content_media: [],
      social_content_insights: [
        {
          provider: "twitter",
          remote_post_id: "historic",
          caption: "A historical founder lesson",
          published_at: "2024-01-10T00:00:00Z",
        },
      ],
      content_source_records: [
        {
          provider: "notion",
          external_item_id: "note",
          record_type: "page",
          title: "Old event",
          body: "A 2024 launch",
          canonical_source_url: "https://example.com/note",
          occurred_at: "2024-01-10T00:00:00Z",
          metadata: {},
        },
      ],
      social_posts: [
        {
          id: "saved",
          body: "A recently saved post",
          settings: {
            card: { slides: [{ heading: "Slide thesis", body: "The saved carousel argument" }] },
          },
          created_at: "2026-10-11T00:00:00Z",
        },
      ],
      content_agent_messages: [
        {
          id: "other-chat",
          payload: { feedback: { type: "rejected", reason: "Repeated argument" } },
        },
      ],
    };
    const builder: Record<string, unknown> = {};
    for (const method of ["select", "order", "limit", "is", "textSearch"])
      builder[method] = vi.fn(() => builder);
    for (const method of ["eq", "gt", "gte"])
      builder[method] = vi.fn((key, value) => {
        query.filters.push([key, value]);
        return builder;
      });
    builder.maybeSingle = vi.fn(() =>
      Promise.resolve({
        data:
          table === "creator_content_profiles"
            ? { niche_keywords: ["startup journey"], language: "en", region: "global" }
            : null,
        error: null,
      }),
    );
    builder.then = (resolve: (value: unknown) => void) =>
      Promise.resolve({ data: rows[table] || [], error: null }).then(resolve);
    return builder;
  }) as unknown as typeof supabaseAdmin.from);
  try {
    const context = await loadContentEditorialContext(
      "workspace",
      "Customer interviews",
      "linkedin",
    );
    expect(requireContentWorkspace).toHaveBeenCalledWith("workspace", "contentAgent");
    expect(
      queries
        .filter((query) => query.table !== "content_trend_briefs")
        .every((query) =>
          query.filters.some(([key, value]) => key === "user_id" && value === "workspace"),
        ),
    ).toBe(true);
    expect(queries.some((query) => query.table === "content_agent_threads")).toBe(false);
    expect(
      queries
        .filter((query) => query.table === "content_agent_messages")
        .every((query) => query.filters.some(([key]) => key === "expires_at")),
    ).toBe(true);
    expect(context.recentOutputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "saved",
          body: "A recently saved post\nSlide thesis The saved carousel argument",
        }),
      ]),
    );
    expect(context.sources.some((source) => source.url === "https://example.com/fiction")).toBe(
      false,
    );
    expect(context.sources.some((source) => source.url === "https://example.com/relevant")).toBe(
      true,
    );
    expect(context.feedback).toEqual([{ type: "rejected", reason: "Repeated argument" }]);
    expect(context.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "notion:note", occurredAt: "2024-01-10T00:00:00Z" }),
      ]),
    );
  } finally {
    from.mockRestore();
  }
});
it("keeps broader explicit chat requests editable in a follow-up", async () => {
  const deps = dependencies();
  const context = await deps.loadContext("creator", threadId);
  vi.mocked(deps.loadContext).mockResolvedValue({
    ...context,
    threadKind: "chat",
    history: [{ role: "user", content: "Write a YouTube script" }],
  });
  vi.mocked(deps.generate).mockResolvedValue({
    action: "draft",
    message: "Revised",
    cards: [{ ...postCard, platform: "youtube", format: "long_script" }],
  });
  const result = await runContentAgentTurn(
    { userId: "creator", threadId, text: "Make it shorter" },
    deps,
  );
  expect(result.result.cards[0]).toMatchObject({ type: "draft", format: "long_script" });
});

const revision = {
  id: "previous:draft",
  messageId: "previous",
  cardId: "draft",
  platform: "twitter",
  format: "post",
  body: "A prototype should answer one question. Choose a useful test.",
  sourceIds: ["notion:page-1"],
  sourceUrls: [],
  sources: [],
};
it("resolves selected-card identity server-side and carries its source context into editing", async () => {
  const deps = dependencies();
  deps.loadRevisionTarget = vi.fn().mockResolvedValue({ ...revision });
  vi.mocked(deps.generate).mockResolvedValue({
    action: "draft",
    message: "Edited",
    cards: [postCard],
  });
  deps.generateEditorial = vi
    .fn()
    .mockResolvedValue({ status: "ready", message: "Ready", issues: [], card: postCard });
  await runContentAgentTurn(
    {
      userId: "creator",
      threadId,
      text: "Tighten it",
      revision: { messageId: "previous", cardId: "draft" },
    },
    deps,
  );
  expect(deps.loadRevisionTarget).toHaveBeenCalledWith("creator", threadId, {
    messageId: "previous",
    cardId: "draft",
  });
  expect(deps.generateEditorial).toHaveBeenCalledWith(
    expect.objectContaining({
      revisionTarget: expect.objectContaining({
        id: revision.id,
        sources: [expect.objectContaining({ id: "notion:page-1" })],
      }),
    }),
    expect.anything(),
  );
});
it("resolves a supported-post follow-up only when a single owned recent draft is identifiable", async () => {
  for (const candidates of [[revision], [revision, { ...revision, id: "other:draft" }]]) {
    const deps = dependencies();
    deps.loadRevisionTarget = vi.fn().mockResolvedValue({ ...revision });
    const context = await deps.loadContext("creator", threadId);
    vi.mocked(deps.loadContext).mockResolvedValue({ ...context, revisionCandidates: candidates });
    vi.mocked(deps.generate).mockResolvedValue({
      action: "draft",
      message: "Edited",
      cards: [postCard],
    });
    deps.generateEditorial = vi
      .fn()
      .mockResolvedValue({ status: "ready", message: "Ready", issues: [], card: postCard });
    await runContentAgentTurn(
      { userId: "creator", threadId, text: "Tighten the second sentence but keep the hook" },
      deps,
    );
    const brief = vi.mocked(deps.generateEditorial).mock.calls[0][0];
    expect(Boolean(brief.revisionTarget)).toBe(candidates.length === 1);
  }
});
it("does not exempt an unrelated new request merely containing edit", async () => {
  const deps = dependencies();
  const context = await deps.loadContext("creator", threadId);
  vi.mocked(deps.loadContext).mockResolvedValue({ ...context, revisionCandidates: [revision] });
  vi.mocked(deps.generate).mockResolvedValue({
    action: "draft",
    message: "New",
    cards: [postCard],
  });
  deps.generateEditorial = vi
    .fn()
    .mockResolvedValue({ status: "ready", message: "Ready", issues: [], card: postCard });
  await runContentAgentTurn(
    { userId: "creator", threadId, text: "Write a new post about how I edit interviews" },
    deps,
  );
  expect(vi.mocked(deps.generateEditorial).mock.calls[0][0].revisionTarget).toBeUndefined();
});
it.each([
  ["linkedin", "carousel", "Write a LinkedIn carousel"],
  ["instagram", "post", "Write an Instagram single post"],
])(
  "preserves explicit ordinary-chat %s/%s and follow-up edits",
  async (platform, format, request) => {
    for (const followup of [false, true]) {
      const deps = dependencies();
      const context = await deps.loadContext("creator", threadId);
      vi.mocked(deps.loadContext).mockResolvedValue({
        ...context,
        threadKind: "chat",
        history: followup ? [{ role: "user", content: request }] : [],
      });
      vi.mocked(deps.generate).mockResolvedValue({
        action: "draft",
        message: "Draft",
        cards: [{ ...postCard, platform, format }],
      });
      const result = await runContentAgentTurn(
        { userId: "creator", threadId, text: followup ? "Make it shorter" : request },
        deps,
      );
      expect(result.result.cards[0]).toMatchObject({ type: "draft", platform, format });
    }
  },
);
it("preserves an honest retry message in interactive output", async () => {
  const deps = dependencies();
  vi.mocked(deps.generate).mockResolvedValue({
    action: "draft",
    message: "Draft",
    cards: [postCard],
  });
  deps.generateEditorial = vi.fn().mockResolvedValue({
    status: "retry",
    reason: "timeout",
    message: "Verification timed out. Try again.",
    issues: [],
    card: {
      type: "idea",
      cardId: "retry",
      title: "Retry",
      premise: "A draft",
      format: "twitter/post",
      takeaway: "Verification timed out. Try again.",
      sourceUrls: [],
    },
  });
  const result = await runContentAgentTurn(
    { userId: "creator", threadId, text: "Write a post" },
    deps,
  );
  expect(result.result.message).toBe("Verification timed out. Try again.");
});
it.each([true, false])("compares accepted sibling drafts: duplicate=%s", async (duplicate) => {
  const deps = dependencies();
  const sibling = {
    ...postCard,
    cardId: "second",
    body: duplicate
      ? postCard.body
      : "Leave silence after a question so the customer can finish a thought.",
  };
  vi.mocked(deps.generate).mockResolvedValue({
    action: "draft",
    message: "Two drafts",
    cards: [postCard, sibling],
  });
  deps.generateEditorial = vi.fn((brief, options) => {
    const candidate = {
      ...(options?.initialDraft as object),
      angle: "Ask a precise question and let the customer answer fully.",
      whyNow: "Use this in the next customer conversation to hear their complete answer.",
    };
    return generateEditorialDraft(brief, {
      ...options,
      dependencies: {
        write: async () => candidate,
        edit: async () => candidate,
        critique: async () => ({ issues: [] }),
      },
    });
  });
  const result = await runContentAgentTurn(
    { userId: "creator", threadId, text: "Write two X posts" },
    deps,
  );
  expect(result.result.cards.map((card) => card.type)).toEqual([
    "draft",
    duplicate ? "idea" : "draft",
  ]);
  expect(vi.mocked(deps.generateEditorial).mock.calls[1][0].recentOutputs).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: "turn:0", body: postCard.body })]),
  );
});
it("includes accepted carousel slides and excludes rejected ideas from sibling comparison", async () => {
  const deps = dependencies();
  vi.mocked(deps.generate).mockResolvedValue({
    action: "draft",
    message: "Drafts",
    cards: [
      {
        ...postCard,
        platform: "instagram",
        format: "carousel",
        slides: [
          { heading: "Ask one question", body: "Test one assumption in each interview" },
          { heading: "Pause", body: "Leave space for a complete answer" },
        ],
      },
      { ...postCard, cardId: "second" },
      { ...postCard, cardId: "third" },
    ],
  });
  deps.generateEditorial = vi
    .fn()
    .mockImplementationOnce(async (_brief, options) => ({
      status: "ready",
      message: "Ready",
      issues: [],
      card: { ...postCard, ...options.initialDraft, type: "draft", cardId: "draft" },
    }))
    .mockResolvedValueOnce({
      status: "needs_input",
      reason: "quality",
      message: "Try another angle",
      issues: [],
      card: {
        type: "idea",
        cardId: "idea",
        title: "Angle",
        premise: "A question",
        format: "twitter/post",
        takeaway: "Try another angle",
        sourceUrls: [],
      },
    })
    .mockResolvedValueOnce({ status: "ready", message: "Ready", issues: [], card: postCard });
  await runContentAgentTurn({ userId: "creator", threadId, text: "Three posts" }, deps);
  const last = vi.mocked(deps.generateEditorial).mock.calls[2][0];
  expect(last.recentOutputs.find((output) => output.id === "turn:0")?.body).toContain(
    "Ask one question Test one assumption",
  );
  expect(last.recentOutputs.some((output) => output.id === "turn:1")).toBe(false);
});
it("resolves revision ownership, thread, assistant role and retention before using a target", async () => {
  const filters: Array<[string, unknown]> = [];
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  for (const method of ["eq", "gt"])
    builder[method] = (key: string, value: unknown) => {
      filters.push([key, value]);
      return builder;
    };
  const single = vi.fn().mockResolvedValue({
    data: { id: "previous", payload: { action: "draft", message: "Draft", cards: [postCard] } },
    error: null,
  });
  builder.maybeSingle = single;
  const from = vi.spyOn(supabaseAdmin, "from").mockReturnValue(builder as never);
  try {
    const target = await loadContentRevisionTarget("owner", threadId, {
      messageId: "previous",
      cardId: "draft",
    });
    expect(target.id).toBe("previous:draft");
    expect(filters).toEqual(
      expect.arrayContaining([
        ["user_id", "owner"],
        ["thread_id", threadId],
        ["role", "assistant"],
        ["id", "previous"],
        ["expires_at", expect.any(String)],
      ]),
    );
    single.mockResolvedValue({ data: null, error: null });
    await expect(
      loadContentRevisionTarget("other-owner", threadId, {
        messageId: "previous",
        cardId: "draft",
      }),
    ).rejects.toThrow("unavailable");
  } finally {
    from.mockRestore();
  }
});

type RevisionRow = {
  id: string;
  user_id: string;
  thread_id: string;
  role: string;
  expires_at: string;
  payload: unknown;
};
function revisionRow(id: string, card: unknown): RevisionRow {
  return {
    id,
    user_id: "creator",
    thread_id: threadId,
    role: "assistant",
    expires_at: "2030-01-01T00:00:00Z",
    payload: { action: "draft", message: "Draft", cards: [card] },
  };
}
function mockRevisionRows(
  rows: Record<string, RevisionRow>,
  posts: Record<string, { id: string; user_id: string; settings: Record<string, unknown> }> = {},
) {
  const reads: Array<Array<[string, unknown]>> = [];
  const from = vi.spyOn(supabaseAdmin, "from").mockImplementation(((table: string) => {
    const filters: Array<[string, unknown]> = [];
    reads.push(filters);
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    for (const method of ["eq", "gt"])
      builder[method] = (key: string, value: unknown) => {
        filters.push([key, value]);
        return builder;
      };
    builder.maybeSingle = async () => {
      const id = filters.find(([key]) => key === "id")?.[1];
      const row = (table === "social_posts" ? posts : rows)[String(id)];
      const owned =
        row &&
        filters.every(([key, value]) =>
          key === "expires_at"
            ? Date.parse((row as RevisionRow).expires_at) > Date.parse(String(value))
            : (row as Record<string, unknown>)[key] === value,
        );
      return { data: owned ? row : null, error: null };
    };
    return builder;
  }) as unknown as typeof supabaseAdmin.from);
  return { from, reads };
}
it.each(["handoff", "prepared"])(
  "exempts only verified %s canonical posts, including revision ancestors",
  async (kind) => {
    const { buildEditorialBrief, validateEditorialDraft } = await import("./content-editorial");
    const postId = "70000000-0000-4000-8000-000000000001";
    const runId = "70000000-0000-4000-8000-000000000002";
    const body =
      "A prototype should answer one question. Pick the question before choosing features.";
    const sourceUrl = "https://publisher.example/original";
    const original = { ...postCard, body, sourceUrls: [sourceUrl] };
    const row = revisionRow("A", original);
    row.payload = {
      ...(row.payload as object),
      ...(kind === "handoff"
        ? { draftStates: { draft: { revision: 0, socialPostId: postId } } }
        : {
            proactive: {
              signalId: "signal",
              signalKey: "key",
              whyNow: "Prepared",
              feedbackActions: [],
              draftBindings: [
                { cardId: "draft", socialPostId: postId, runId, body, title: original.title },
              ],
            },
          }),
    };
    const rows = {
      A: row,
      B: revisionRow("B", {
        ...original,
        editorial: {
          angle: "One question",
          whyNow: "Next prototype",
          sourceIds: [],
          validationState: "passed",
          revisionOf: { messageId: "A", cardId: "draft" },
        },
      }),
    };
    const posts = {
      [postId]: {
        id: postId,
        user_id: "creator",
        settings:
          kind === "handoff"
            ? { agentMessageId: "A", agentCardId: "draft" }
            : { routineRunId: runId, card: original },
      },
    };
    const { from } = mockRevisionRows(rows, posts);
    try {
      for (const messageId of ["A", "B"]) {
        const target = await loadContentRevisionTarget("creator", threadId, {
          messageId,
          cardId: "draft",
        });
        expect(target.canonicalPostIds).toEqual([postId]);
        const brief = buildEditorialBrief({
          brain: [],
          sources: [
            {
              id: "evidence",
              title: "Prototype scope",
              text: "Choose a testable question.",
              occurredAt: null,
              external: true,
              url: sourceUrl,
            },
          ],
          platform: "twitter",
          revisionTarget: target,
          recentOutputs: [
            { id: postId, body },
            { id: "unrelated", body: "Different topic." },
          ],
        });
        expect(brief.recentOutputs.map((p) => p.id)).toEqual(["unrelated"]);
        const revised = {
          platform: original.platform,
          format: original.format,
          title: original.title,
          sourceUrls: original.sourceUrls,
          visualBrief: null,
          body: "A prototype should answer one question. Start with the simplest test.",
          angle: "Let one precise question decide the prototype scope.",
          whyNow: "Use the next prototype to test a decision before adding features.",
          sourceIds: ["evidence"],
          claims: [],
        };
        expect(
          validateEditorialDraft(brief, revised, [{ id: postId, body }]).map((i) => i.code),
        ).not.toContain("copied_hook");
        expect(
          validateEditorialDraft(brief, revised, [{ id: "unrelated", body }]).map((i) => i.code),
        ).toContain("copied_hook");
        const dependencies = {
          write: async () => revised,
          edit: async () => revised,
          critique: async () => ({ issues: [] }),
        };
        const generated = await generateEditorialDraft(brief, { dependencies });
        expect(generated.status).toBe("ready");
        expect(generated.card).toMatchObject({
          sourceUrls: [sourceUrl],
          editorial: {
            revisionOf: { messageId, cardId: "draft" },
          },
        });
        expect(
          (
            await generateEditorialDraft(
              { ...brief, recentOutputs: [{ id: "unrelated", body }] },
              { dependencies },
            )
          ).issues.map((issue) => issue.code),
        ).toContain("copied_hook");
      }
      // A persisted forward pointer cannot exempt another owner's post or an unrelated owned post.
      posts[postId].user_id = "foreign";
      expect(
        (await loadContentRevisionTarget("creator", threadId, { messageId: "A", cardId: "draft" }))
          .canonicalPostIds,
      ).toEqual([]);
      posts[postId].user_id = "creator";
      posts[postId].settings =
        kind === "handoff"
          ? { agentMessageId: "unrelated-message", agentCardId: "draft" }
          : { routineRunId: "unrelated-run", card: original };
      const target = await loadContentRevisionTarget("creator", threadId, {
        messageId: "A",
        cardId: "draft",
      });
      expect(target.canonicalPostIds).toEqual([]);
      expect(
        buildEditorialBrief({
          brain: [],
          sources: [],
          revisionTarget: target,
          recentOutputs: [{ id: postId, body }],
        }).recentOutputs.map((p) => p.id),
      ).toEqual([postId]);
    } finally {
      from.mockRestore();
    }
  },
);
it.each(["selected", "inferred"])(
  "keeps the same hook through two successive %s revisions using verified lineage",
  async (mode) => {
    const original = {
      ...postCard,
      body: "A prototype should answer one question. Pick the question before choosing features.",
    };
    const rows = { A: revisionRow("A", original) } as Record<string, RevisionRow>;
    const { from, reads } = mockRevisionRows(rows);
    const deps = dependencies();
    const base = await deps.loadContext("creator", threadId);
    let currentId = "A";
    let nextId = "B";
    vi.mocked(deps.loadContext).mockImplementation(async () => ({
      ...base,
      threadKind: "chat",
      recentOutputs: Object.values(rows).map((row) => ({
        id: `${row.id}:draft`,
        body: original.body,
      })),
      revisionCandidates: [
        { ...revision, id: `${currentId}:draft`, messageId: currentId, body: original.body },
      ],
    }));
    vi.mocked(deps.generate).mockResolvedValue({
      action: "draft",
      message: "Revised",
      cards: [original],
    });
    vi.mocked(deps.saveMessage).mockImplementation(async (input) => {
      if (input.role !== "assistant") return "user";
      const id = nextId;
      rows[id] = { ...revisionRow(id, original), payload: input.payload };
      return id;
    });
    deps.generateEditorial = vi.fn((brief, options) => {
      const candidate = {
        ...(options?.initialDraft as object),
        angle: "Let one precise question decide the prototype's scope.",
        whyNow: "Use the next prototype to test a single decision before adding features.",
        body:
          currentId === "A"
            ? "A prototype should answer one question. Choose the question before the features."
            : "A prototype should answer one question. Start with the simplest test.",
      };
      return generateEditorialDraft(brief, {
        ...options,
        dependencies: {
          write: async () => candidate,
          edit: async () => candidate,
          critique: async () => ({ issues: [] }),
        },
      });
    });
    try {
      for (const id of ["A", "B"]) {
        currentId = id;
        nextId = id === "A" ? "B" : "C";
        const result = await runContentAgentTurn(
          {
            userId: "creator",
            threadId,
            text: "Tighten the ending but keep the hook",
            ...(mode === "selected" ? { revision: { messageId: id, cardId: "draft" } } : {}),
          },
          deps,
        );
        expect(result.result.cards[0]).toMatchObject({
          type: "draft",
          editorial: { revisionOf: { messageId: id, cardId: "draft" } },
        });
      }
      const second = vi.mocked(deps.generateEditorial).mock.calls[1][0];
      expect(second.revisionTarget?.ancestorIds).toEqual(["A:draft"]);
      expect(second.recentOutputs).toEqual([]);
      expect(reads).toHaveLength(3);
      expect(
        reads.every(
          (filters) =>
            filters.some(([key, value]) => key === "user_id" && value === "creator") &&
            filters.some(([key, value]) => key === "thread_id" && value === threadId) &&
            filters.some(([key]) => key === "expires_at"),
        ),
      ).toBe(true);
    } finally {
      from.mockRestore();
    }
  },
);
it("bounds lineage traversal and verifies every ancestor before exempting it", async () => {
  const metadata = {
    sourceIds: [],
    angle: "One practical test",
    whyNow: "The next prototype",
    validationState: "passed",
  };
  const rows: Record<string, RevisionRow> = {};
  for (let index = 0; index < 25; index++)
    rows[`m${index}`] = revisionRow(`m${index}`, {
      ...postCard,
      editorial: { ...metadata, revisionOf: { messageId: `m${index + 1}`, cardId: "draft" } },
    });
  const { from, reads } = mockRevisionRows(rows);
  try {
    const target = await loadContentRevisionTarget("creator", threadId, {
      messageId: "m0",
      cardId: "draft",
    });
    expect(target.ancestorIds).toHaveLength(20);
    expect(reads).toHaveLength(21);
    rows.m1.user_id = "other-owner";
    expect(
      (await loadContentRevisionTarget("creator", threadId, { messageId: "m0", cardId: "draft" }))
        .ancestorIds,
    ).toEqual([]);
    rows.m1.user_id = "creator";
    rows.m1.expires_at = "2020-01-01T00:00:00Z";
    expect(
      (await loadContentRevisionTarget("creator", threadId, { messageId: "m0", cardId: "draft" }))
        .ancestorIds,
    ).toEqual([]);
  } finally {
    from.mockRestore();
  }
});
it.each([false, true])(
  "preserves all clause-associated broader pairs and follow-ups=%s while rejecting an unrequested cross-pair",
  async (followup) => {
    const deps = dependencies();
    const base = await deps.loadContext("creator", threadId);
    const request = "Write a Facebook post and a LinkedIn carousel";
    vi.mocked(deps.loadContext).mockResolvedValue({
      ...base,
      threadKind: "chat",
      history: followup ? [{ role: "user", content: request }] : [],
    });
    vi.mocked(deps.generate).mockResolvedValue({
      action: "draft",
      message: "Drafts",
      cards: [
        { ...postCard, cardId: "fb", platform: "facebook", format: "post" },
        { ...postCard, cardId: "li", platform: "linkedin", format: "carousel" },
        { ...postCard, cardId: "unrequested", platform: "facebook", format: "carousel" },
      ],
    });
    const result = await runContentAgentTurn(
      { userId: "creator", threadId, text: followup ? "Make both shorter" : request },
      deps,
    );
    expect(result.result.cards.map((card) => card.type)).toEqual(["draft", "draft", "idea"]);
  },
);
it("keeps named-agent restrictions for mixed explicit broader pairs", async () => {
  const deps = dependencies();
  const base = await deps.loadContext("creator", threadId);
  vi.mocked(deps.loadContext).mockResolvedValue({ ...base, threadKind: "agent" });
  vi.mocked(deps.generate).mockResolvedValue({
    action: "draft",
    message: "Drafts",
    cards: [
      { ...postCard, platform: "facebook", format: "post" },
      { ...postCard, cardId: "li", platform: "linkedin", format: "carousel" },
    ],
  });
  const result = await runContentAgentTurn(
    { userId: "creator", threadId, text: "Write a Facebook post and a LinkedIn carousel" },
    deps,
  );
  expect(result.result.cards.map((card) => card.type)).toEqual(["idea", "idea"]);
});

it("rejects a full Brain batch when an exact quote supports a review but not product ownership", async () => {
  const item = {
    kind: "profile",
    title: "My Human",
    content: "I developed Instinct and raised $10 million.",
    provenance: "social_post",
    sourceRef: "post-1",
    evidence: [{ sourceRef: "post-1", quote: "I reviewed Instinct" }],
  };
  const ai = {
    run: vi
      .fn()
      .mockResolvedValueOnce({ response: JSON.stringify({ suggestions: withStrategies([item]) }) })
      .mockImplementation(async (_model, input) => {
        const payload = JSON.parse(
          input.messages.find((message: { role: string }) => message.role === "user").content,
        );
        expect(payload.corrections).toEqual([
          {
            title: "Ownership correction",
            content: "I only made a video reviewing Instinct; I never built it.",
          },
        ]);
        expect(payload.documents[0].content).toContain("$10 million");
        return {
          response: JSON.stringify({
            reviews: payload.documents.map((document: { id: string }, index: number) => ({
              id: document.id,
              approved: index !== 0,
              sourceIds: [payload.sources[0].id],
              issues:
                index === 0 ? ["The quote refers to reviewing, not building or fundraising."] : [],
            })),
          }),
        };
      }),
  };
  await expect(
    generateConnectedBrainSuggestions(
      [
        {
          provider: "youtube",
          remote_post_id: "review",
          caption:
            "I reviewed Instinct, built by another founder. This is my video about their app.",
        },
      ],
      undefined,
      { AI: ai },
      [
        {
          id: "correction",
          kind: "instruction",
          title: "Ownership correction",
          content: "I only made a video reviewing Instinct; I never built it.",
          status: "confirmed",
          provenance: "creator",
          locked: true,
          sourceUrl: null,
          sourceRef: null,
          createdAt: "",
          updatedAt: "",
        },
      ],
    ),
  ).rejects.toThrow("could not be verified");
  expect(ai.run).toHaveBeenCalledTimes(2);
});

it("generates a complete bounded Brain from concise factual documents without asking the model to format two strategies", async () => {
  const suggestions = [
    {
      kind: "profile",
      title: "My Human",
      content: "I build creator tools and review other teams' AI products.",
    },
    {
      kind: "instruction",
      title: "Writing voice",
      content: "I write short, direct explanations about building useful tools.",
    },
    {
      kind: "story",
      title: "Testing with one user",
      content: "I tested my prototype with one real user before adding more features.",
    },
  ].map((item) => ({
    ...item,
    provenance: "social_post",
    sourceRef: "post-1",
    tags: ["creator tools"],
    evidence: [{ sourceRef: "post-1", quote: "I build creator tools" }],
  }));
  const ai = {
    run: vi
      .fn()
      .mockResolvedValueOnce({ response: JSON.stringify({ suggestions }) })
      .mockImplementation(async (_model, input) => brainReviewResponse(input)),
  };
  const publishing = contentProfileSchema.parse({
    nicheKeywords: ["creator tools"],
    goal: "reach_growth",
    timezone: "Asia/Kolkata",
    platformFrequencies: { twitter: 0 },
  });
  const result = await generateConnectedBrainSuggestions(
    [
      {
        provider: "youtube",
        remote_post_id: "evidence",
        caption:
          "I build creator tools and review other teams' AI products. I tested my prototype with one real user before adding more features.",
      },
    ],
    publishing,
    { AI: ai },
  );
  expect(ai.run).toHaveBeenCalledTimes(2);
  expect(ai.run.mock.calls[0][1]).toMatchObject({ max_tokens: 6000 });
  expect(ai.run.mock.calls[0][1].messages[0].content).not.toContain("Extract up to six");
  const plans = result.filter((item) => item.kind === "strategy");
  expect(plans.map((item) => item.title)).toEqual(["X Strategy", "LinkedIn Strategy"]);
  for (const plan of plans) expect(completeContentStrategy(plan.content)).toBe(true);
  expect(plans[0].content).toContain("Publishing is paused");
  expect(plans[1].content).toContain("Not configured");
  expect(plans[1].content).not.toContain("Prepare 3 posts per week");
  const reviewed = JSON.parse(
    ai.run.mock.calls[1][1].messages.find((message: { role: string }) => message.role === "user")
      .content,
  );
  expect(reviewed.documents).toHaveLength(5);
  expect(
    reviewed.documents.some((document: { title: string }) => document.title === "My Human"),
  ).toBe(true);
  expect(
    reviewed.documents.filter((document: { kind: string }) => document.kind === "strategy"),
  ).toHaveLength(2);
});

it("uses supported strict JSON schema for OpenRouter Brain generation and keeps full-batch verification", async () => {
  const requests: Array<{
    messages: Array<{ role: string; content: string }>;
    response_format: { json_schema: { schema: { properties: { suggestions: unknown } } } };
  }> = [];
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    requests.push(request);
    const payload = JSON.parse(
      request.messages.find((message: { role: string }) => message.role === "user").content,
    );
    const value = payload.documents
      ? {
          reviews: payload.documents.map((document: { id: string }) => ({
            id: document.id,
            approved: true,
            sourceIds: [payload.sources[0].id],
            issues: [],
          })),
        }
      : {
          suggestions: [
            {
              kind: "profile",
              title: "My Human",
              content: "I build creator tools.",
              provenance: "social_post",
              sourceRef: "post-1",
              tags: ["creator tools"],
              evidence: [{ sourceRef: "post-1", quote: "I build creator tools." }],
            },
          ],
        };
    return Response.json({
      choices: [{ message: { content: JSON.stringify(value) }, finish_reason: "stop" }],
      usage: { cost: 0.001 },
    });
  });
  try {
    const result = await generateConnectedBrainSuggestions(
      [{ provider: "youtube", remote_post_id: "source", caption: "I build creator tools." }],
      undefined,
      { AI_TEXT_PROVIDER: "openrouter", OPENROUTER_API_KEY: "test-key" },
    );
    expect(result).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(requests[0]).toMatchObject({
      model: "z-ai/glm-5.3-flash",
      max_tokens: 6000,
      reasoning: { effort: "low" },
      response_format: { type: "json_schema", json_schema: { strict: true } },
    });
    const shape = requests[0].response_format.json_schema.schema.properties.suggestions;
    expect(shape).toMatchObject({
      maxItems: 5,
      items: {
        properties: {
          content: { maxLength: 1200 },
          sourceRef: { enum: ["post-1"] },
          evidence: { maxItems: 2 },
        },
      },
    });
    const review = JSON.parse(
      requests[1].messages.find((message: { role: string }) => message.role === "user")!.content,
    );
    expect(review.documents).toHaveLength(3);
  } finally {
    fetcher.mockRestore();
  }
});

it("reserves the full 6K Brain completion ceiling and sends nothing when its budget is denied", async () => {
  const reservation = vi.spyOn(providerBudget, "aiReservationMicrousd");
  vi.mocked(providerBudget.reserveAiProviderUsage).mockRejectedValueOnce(
    new providerBudget.ProviderBudgetError("ai_microusd"),
  );
  const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network allowed"));
  try {
    await expect(
      generateConnectedBrainSuggestions(
        [{ provider: "youtube", remote_post_id: "source", caption: "I build creator tools." }],
        undefined,
        { AI_TEXT_PROVIDER: "openrouter", OPENROUTER_API_KEY: "test-key" },
      ),
    ).rejects.toBeInstanceOf(providerBudget.ProviderBudgetError);
    expect(reservation).toHaveBeenCalledWith(expect.any(Object), 6000, {
      input: 0.15,
      output: 0.5,
    });
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    reservation.mockRestore();
    fetcher.mockRestore();
  }
});

it("retains the full reviewer source pack and bundles many creator corrections", async () => {
  const item = {
    kind: "profile",
    title: "My Human",
    content: "I build creator tools.",
    provenance: "social_post",
    sourceRef: "post-1",
    tags: [],
    evidence: [{ sourceRef: "post-1", quote: "I build creator tools." }],
  };
  const ai = {
    run: vi
      .fn()
      .mockResolvedValueOnce({ response: JSON.stringify({ suggestions: [item] }) })
      .mockImplementation(async (_model, input) => {
        const payload = JSON.parse(
          input.messages.find((message: { role: string }) => message.role === "user").content,
        );
        return {
          response: JSON.stringify({
            reviews: payload.documents.map((document: { id: string }) => ({
              id: document.id,
              approved: true,
              sourceIds: ["instagram:post-2"],
              issues: [],
            })),
          }),
        };
      }),
  };
  const corrections = Array.from({ length: 32 }, (_, index) => ({
    id: `correction-${index}`,
    kind: "instruction" as const,
    title: `Correction ${index}`,
    content: `Creator correction ${index}.`,
    provenance: "creator" as const,
    sourceUrl: null,
    sourceRef: null,
    status: "confirmed" as const,
    locked: true,
    tags: [],
    createdAt: "2026-10-23T00:00:00Z",
    updatedAt: "2026-10-23T00:00:00Z",
  }));
  const result = await generateConnectedBrainSuggestions(
    [
      { provider: "threads", remote_post_id: "post-1", caption: "I build creator tools." },
      { provider: "instagram", remote_post_id: "post-2", caption: "I build tools for creators." },
    ],
    undefined,
    { AI_TEXT_PROVIDER: "workers-ai", AI: ai },
    corrections,
  );
  expect(ai.run).toHaveBeenCalledTimes(2);
  expect(result[0].evidenceVerification?.sources.map((source) => source.id)).toEqual(
    expect.arrayContaining(["threads:post-1", "instagram:post-2", "creator-corrections"]),
  );
  expect(result[0].evidenceVerification?.sources).toHaveLength(3);
});
