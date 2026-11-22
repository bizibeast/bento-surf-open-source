import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod-v4";
const mocks = vi.hoisted(() => ({ from: vi.fn(), tools: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock("./mcp.server", () => ({ createBentoAppTools: mocks.tools }));
vi.mock("./ai-json.server", () => ({
  runAiJson: vi.fn(() => {
    throw new Error("No paid calls in tests");
  }),
}));
import {
  generateAgentWithTools,
  approveAgentAppAction,
  editAgentPostAction,
  agentActionErrorMessage,
  agentEntityLabels,
  AGENT_TOOL_STEP_LIMIT,
  type AgentToolContext,
} from "./content-agent-tools.server";
import { withBennyEditingModel } from "./benny-models.server";
import { withManagedProviderBudget } from "./provider-budget.server";
import type { BentoAppTool } from "./mcp.server";
const id = "00000000-0000-4000-8000-000000000001";
const revision = "2026-10-16T12:00:00.000Z";
const context = {
  userId: id,
  accessToken: "user-jwt",
  supabase: {} as AgentToolContext["supabase"],
};
const reply = { action: "answer", message: "Prepared", cards: [], memories: [], toolRequest: null };
const call = (name: string, args = {}) => ({
  ...reply,
  toolRequest: { name, argumentsJson: JSON.stringify(args) },
});
const tool = (name: string, readOnly: boolean): BentoAppTool => ({
  name,
  title: name,
  description: name,
  readOnly,
  inputSchema: z.object({}),
  execute: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Saved" }] }),
});
beforeEach(() => vi.clearAllMocks());
it("reads Instagram audio in chat and keeps the selected track in a publishing approval", async () => {
  const audio = tool("get_instagram_audio_catalog", true);
  audio.inputSchema = z.object({ connectionId: z.uuid(), workspaceId: z.uuid().optional() });
  vi.mocked(audio.execute).mockResolvedValue({
    content: [],
    structuredContent: {
      catalog: {
        connected: true,
        mode: "trending",
        tracks: [{ id: "587784541076604", title: "Track", creator: "Artist" }],
      },
    },
  });
  const post = tool("create_social_post", false);
  post.inputSchema = z.object({ body: z.string() }).passthrough();
  const media = {
    key: "image/owner/reel.mp4",
    url: "https://cdn.bento.surf/reel.mp4",
    name: "reel.mp4",
    mimeType: "video/mp4",
    size: 10000,
  };
  const selected = {
    sourceKey: media.key,
    connectionId: id,
    audioId: "587784541076604",
    title: "Track",
    creator: "Artist",
    trackVolume: 25,
    originalVolume: 100,
  };
  const generate = vi.fn(async (request) => {
    if (!request.input.observations.length) {
      expect(request.input.schemas.get_instagram_audio_catalog).toBeDefined();
      return call(audio.name, { connectionId: id });
    }
    expect(JSON.stringify(request.input.observations)).toContain("587784541076604");
    return call(post.name, {
      body: "Ready for review",
      connectionIds: [id],
      mode: "draft",
      media: [media],
      providerSettings: { instagram: { catalogAudio: selected } },
    });
  });
  const result = await generateAgentWithTools(
    JSON.stringify({ request: "Choose trending audio for my Instagram Reel draft" }),
    context,
    "System",
    {},
    {
      tools: new Map([
        [audio.name, audio],
        [post.name, post],
      ]),
      generate,
    },
  );
  expect(result.actions).toHaveLength(1);
  expect(result.actions[0].arguments.providerSettings).toEqual({
    instagram: { catalogAudio: selected },
  });
  expect(post.execute).not.toHaveBeenCalled();
});
describe("Agent tool execution", () => {
  it("fits a long conversation without dropping the newest request or approved edits", async () => {
    const latest = {
      id,
      arguments: { body: "Creator-approved exact caption" },
      result: {
        structuredContent: {
          entry: { id, title: "Saved project", notes: "evidence".repeat(3000) },
        },
        content: [{ type: "text", text: "duplicate evidence".repeat(3000) }],
      },
    };
    const generate = vi.fn(async (request) => {
      const serialized = JSON.stringify({
        system: request.system,
        input: JSON.stringify(request.input),
        responseFormat: request.responseFormat,
      });
      if (new TextEncoder().encode(serialized).byteLength > 128000)
        throw new Error("AI request is too large");
      expect(request.input.context.request).toBe("Prepare the saved Reel estimate, do not publish");
      expect(request.input.context.actionOutcomes.at(-1).arguments.body).toBe(
        "Creator-approved exact caption",
      );
      expect(request.input.context.actionOutcomes.at(-1).result.structuredContent.entry.id).toBe(
        id,
      );
      return reply;
    });
    const input = {
      request: "Prepare the saved Reel estimate, do not publish",
      actionOutcomes: [latest],
      recentConversation: Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 ? "assistant" : "user",
        content: "Earlier conversation ".repeat(500),
        proposedActions: [{ id, arguments: latest.arguments }],
      })),
    };
    const original = JSON.stringify(input);
    await expect(
      generateAgentWithTools(original, context, "rules", {}, { tools: new Map(), generate }),
    ).resolves.toMatchObject({ result: { action: "answer" }, actions: [] });
    expect(JSON.stringify(input)).toBe(original);
  });
  it("supplies trusted workspace and request IDs so analysis needs no user-provided IDs", async () => {
    const analyze = tool("analyze_content_reference", false);
    analyze.inputSchema = z.object({ workspaceId: z.uuid(), requestId: z.uuid() });
    const generate = vi.fn(async (request) => {
      const selected = request.input.context;
      return call(analyze.name, {
        workspaceId: selected.workspaceId,
        requestId: selected.requestId,
      });
    });
    const result = await generateAgentWithTools(
      JSON.stringify({ workspaceId: "forged", requestId: "forged" }),
      context,
      "rules",
      {},
      {
        tools: new Map([[analyze.name, analyze]]),
        generate,
      },
    );
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].arguments.workspaceId).toBe(id);
    expect(result.actions[0].arguments.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(analyze.execute).not.toHaveBeenCalled();
  });
  it("sends a strict card union accepted by the managed structured-output API", async () => {
    const generate = vi.fn(async (request) => {
      const items = request.responseFormat.json_schema.schema.properties.cards.items;
      // The live provider rejects oneOf at cards.items before generating any output.
      if ("oneOf" in items) throw new Error("Invalid schema: oneOf is not permitted");
      expect(items.anyOf).toHaveLength(6);
      for (const card of items.anyOf)
        expect(card.properties.type).toMatchObject({ type: "string" });
      expect(
        items.anyOf.map(
          (card: { properties: { type: { const: string } } }) => card.properties.type.const,
        ),
      ).toEqual(["source", "idea", "draft", "brain_proposal", "weekly_plan", "schedule_proposal"]);
      expect(request.responseFormat.json_schema.strict).toBe(true);
      return reply;
    });
    await expect(
      generateAgentWithTools(
        "{}",
        context,
        "rules",
        {},
        {
          tools: new Map(),
          generate,
        },
      ),
    ).resolves.toMatchObject({ result: { action: "answer" }, actions: [] });
  });
  it("executes bounded reads but saves mutations for review without running them", async () => {
    const read = tool("list_social_accounts", true),
      write = tool("save_auto_dm_automation", false);
    const generate = vi
      .fn()
      .mockResolvedValueOnce(call(read.name))
      .mockResolvedValueOnce(call(write.name));
    const result = await generateAgentWithTools(
      "{}",
      context,
      "rules",
      {},
      {
        tools: new Map([
          [read.name, read],
          [write.name, write],
        ]),
        generate,
      },
    );
    expect(read.execute).toHaveBeenCalledOnce();
    expect(write.execute).not.toHaveBeenCalled();
    expect(result.actions[0].tool).toBe(write.name);
    expect(result.result.message).toContain("review");
  });
  it.each([true, false])(
    "snapshots the correct reference model for an explicit provider: %s",
    async (ownProvider) => {
      const write = tool("create_content_from_reference", false);
      write.inputSchema = z.object({
        aiProviderId: z.uuid().optional(),
        aiModel: z.string().optional(),
      });
      const args = ownProvider ? { aiProviderId: id, aiModel: "owned/model" } : {};
      const generate = vi.fn().mockResolvedValue(call(write.name, args));
      const model = "openai/gpt-6.2-sol";
      const result = await withManagedProviderBudget({ workspaceId: id, authUserId: id }, () =>
        withBennyEditingModel(model, () =>
          generateAgentWithTools(
            "{}",
            context,
            "rules",
            {},
            { tools: new Map([[write.name, write]]), generate },
          ),
        ),
      );
      expect(result.actions[0].arguments).toEqual(ownProvider ? args : { aiModel: model });
      expect(write.execute).not.toHaveBeenCalled();
    },
  );
  it("advertises and executes owned post details from Benny's real tool registry as a read", async () => {
    const actual = await vi.importActual<typeof import("./mcp.server")>("./mcp.server");
    const postId = "00000000-0000-4000-8000-000000000002";
    const getSocialPost = vi.fn(async () => ({
      post: { id: postId, body: "Owned caption", targets: [] },
      attempts: [],
      attemptsPagination: { limit: 20, hasMore: false, nextCursor: null },
    }));
    const tools = actual.createBentoAppTools(context, "https://app.bento.surf", {
      ...actual.defaultBentoMcpOperations,
      getSocialPost:
        getSocialPost as unknown as typeof actual.defaultBentoMcpOperations.getSocialPost,
    });
    const generate = vi
      .fn()
      .mockResolvedValueOnce(call("get_social_post", { id: postId, userId: "untrusted-owner" }))
      .mockResolvedValueOnce(reply);
    const result = await generateAgentWithTools("{}", context, "rules", {}, { tools, generate });
    const firstInput = generate.mock.calls[0][0].input;
    expect(firstInput.catalog).toContainEqual(
      expect.objectContaining({ name: "get_social_post", requiresApproval: false }),
    );
    expect(firstInput.schemas.get_social_post).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["id"]),
    });
    expect(getSocialPost).toHaveBeenCalledExactlyOnceWith(id, { id: postId, attemptsLimit: 20 });
    const observation = generate.mock.calls[1][0].input.observations.find(
      (item: { tool: string }) => item.tool === "get_social_post",
    );
    expect(JSON.parse(observation.result).structuredContent.post).toMatchObject({
      body: "Owned caption",
    });
    expect(result.actions).toEqual([]);
  });

  it("deduplicates read requests and stops after five model steps", async () => {
    const read = tool("read", true),
      generate = vi.fn().mockResolvedValue(call("read"));
    const result = await generateAgentWithTools(
      "{}",
      context,
      "rules",
      {},
      { tools: new Map([["read", read]]), generate },
    );
    expect(read.execute).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledTimes(AGENT_TOOL_STEP_LIMIT);
    expect(result.actions).toEqual([]);
  });
  it("validates arguments and removes secret fields from read results", async () => {
    const read = tool("read", true);
    read.inputSchema = z.object({ limit: z.number().max(3) });
    vi.mocked(read.execute).mockResolvedValue({
      structuredContent: {
        access_token: "secret",
        profiles: [{ name: "Taylor", password: "hidden" }],
      },
    });
    const generate = vi
      .fn()
      .mockResolvedValueOnce(call("read", { limit: 100 }))
      .mockResolvedValueOnce(call("read", { limit: 3 }))
      .mockResolvedValueOnce(reply);
    await generateAgentWithTools(
      "{}",
      context,
      "rules",
      {},
      { tools: new Map([["read", read]]), generate },
    );
    expect(read.execute).toHaveBeenCalledTimes(1);
    const observed = JSON.stringify(generate.mock.calls[2][0].input.observations);
    expect(observed).toContain("Taylor");
    expect(observed).not.toContain("secret");
    expect(observed).not.toContain("hidden");
  });
  it("rejects em dashes and missing scheduling details before presenting an action", async () => {
    const post = tool("create_social_post", false);
    post.inputSchema = z.object({
      body: z.string(),
      mode: z.string(),
      connectionIds: z.array(z.string()),
    });
    const generate = vi
      .fn()
      .mockResolvedValueOnce(
        call(post.name, { body: "Hello \u2014 world", mode: "draft", connectionIds: [] }),
      )
      .mockResolvedValueOnce(reply);
    const result = await generateAgentWithTools(
      "{}",
      context,
      "rules",
      {},
      { tools: new Map([[post.name, post]]), generate },
    );
    expect(result.actions).toEqual([]);
    expect(post.execute).not.toHaveBeenCalled();
    expect(JSON.stringify(generate.mock.calls[1][0].input.observations)).toContain("em dashes");
  });
});
function database(row: Record<string, unknown>, messageExists = true) {
  row.updated_at ||= revision;
  mocks.from.mockImplementation((table: string) => {
    const filters: Record<string, unknown> = {};
    let update: Record<string, unknown> | undefined;
    const q = {
      select: () => q,
      eq: (k: string, v: unknown) => {
        filters[k] = v;
        return q;
      },
      gt: () => q,
      update: (v: Record<string, unknown>) => {
        update = v;
        return q;
      },
      maybeSingle: async () => run(),
      then: (resolve: (value: ReturnType<typeof run>) => unknown) =>
        Promise.resolve(run()).then(resolve),
    };
    function run() {
      if (table === "content_agent_messages")
        return { data: messageExists ? { id: row.message_id } : null, error: null };
      const matches = Object.entries(filters).every(([k, v]) => row[k] === v);
      if (!matches) return { data: null, error: null };
      if (update) Object.assign(row, update);
      return { data: { ...row }, error: null };
    }
    return q;
  });
}
describe("Agent action approvals", () => {
  it("retains a bounded structured tool receipt for later turns without storing credentials", async () => {
    const write = tool("save", false);
    vi.mocked(write.execute).mockResolvedValue({
      content: [{ type: "text", text: "Saved project" }],
      structuredContent: { entry: { id, revision: 2 }, apiToken: "do-not-store" },
    });
    mocks.tools.mockReturnValue(new Map([["save", write]]));
    const row = {
      id,
      user_id: id,
      message_id: id,
      status: "pending",
      tool_name: "save",
      arguments: {},
      result: null as unknown,
    };
    database(row);
    await approveAgentAppAction(context, id, false, revision);
    expect(row.result).toEqual({
      message: "Saved project",
      structuredContent: { entry: { id, revision: 2 } },
    });
  });
  it("labels reviewed targets from owned records while ignoring secret data", () => {
    expect(
      agentEntityLabels([
        {
          products: [{ id, title: "Founder's workshop" }],
          secret: { id: "00000000-0000-4000-8000-000000000002", name: "Hidden" },
        },
      ]),
    ).toEqual({ [id]: "Founder's workshop" });
  });

  it("formats field errors without raw validator JSON", () => {
    const parsed = z
      .object({ replyText: z.string().min(1, "Add the DM reply") })
      .safeParse({ replyText: "" });
    expect(agentActionErrorMessage(parsed.error)).toBe("reply Text: Add the DM reply");
  });

  it("claims a pending action once even with simultaneous approvals", async () => {
    const write = tool("save", false);
    mocks.tools.mockReturnValue(new Map([["save", write]]));
    database({
      id,
      user_id: id,
      message_id: id,
      status: "pending",
      tool_name: "save",
      arguments: {},
    });
    const results = await Promise.all([
      approveAgentAppAction(context, id, false, revision),
      approveAgentAppAction(context, id, false, revision),
    ]);
    expect(write.execute).toHaveBeenCalledOnce();
    expect(results.some((r) => r.status === "completed")).toBe(true);
  });
  it("does not execute another workspace's action or an expired review", async () => {
    const write = tool("save", false);
    mocks.tools.mockReturnValue(new Map([["save", write]]));
    database({
      id,
      user_id: "other",
      message_id: id,
      status: "pending",
      tool_name: "save",
      arguments: {},
    });
    await expect(approveAgentAppAction(context, id, false, revision)).rejects.toThrow(
      "unavailable",
    );
    database(
      { id, user_id: id, message_id: id, status: "pending", tool_name: "save", arguments: {} },
      false,
    );
    await expect(approveAgentAppAction(context, id, false, revision)).rejects.toThrow("expired");
    expect(write.execute).not.toHaveBeenCalled();
  });
  it("dismisses without mutation and does not retry failed writes", async () => {
    const write = tool("save", false);
    mocks.tools.mockReturnValue(new Map([["save", write]]));
    database({
      id,
      user_id: id,
      message_id: id,
      status: "pending",
      tool_name: "save",
      arguments: {},
    });
    expect((await approveAgentAppAction(context, id, true, revision)).status).toBe("dismissed");
    expect(write.execute).not.toHaveBeenCalled();
    database({
      id,
      user_id: id,
      message_id: id,
      status: "pending",
      tool_name: "save",
      arguments: {},
    });
    vi.mocked(write.execute).mockRejectedValue(new Error("Platform permission is missing"));
    expect((await approveAgentAppAction(context, id, false, revision)).message).toContain(
      "permission",
    );
    await approveAgentAppAction(context, id, false, revision);
    expect(write.execute).toHaveBeenCalledOnce();
  });
});

describe("one request to multiple network posts", () => {
  const other = "00000000-0000-4000-8000-000000000002";
  const photo = {
    id: 42,
    provider: "pixabay",
    previewUrl: "https://cdn.pixabay.com/photo.jpg",
    url: "https://pixabay.com/photos/42",
    photographer: "Sam",
    description: "A pottery studio",
  };
  const args = {
    body: "Workshop Saturday",
    connectionIds: [id, other],
    connectionOverrides: {
      [id]: { bodyOverride: "A LinkedIn workshop story" },
      [other]: { bodyOverride: "A short X update" },
    },
    mode: "schedule",
    scheduledAt: "2099-10-22T18:00:00Z",
    timezone: "UTC",
    stockPhoto: { id: 42, provider: "pixabay" },
  };
  it("prepares tailored captions and a real stock selection without importing or scheduling before approval", async () => {
    const read = tool("search_stock_photos", true),
      write = tool("create_social_post", false);
    read.inputSchema = z.object({ query: z.string() });
    write.inputSchema = z.object({}).passthrough();
    vi.mocked(read.execute).mockResolvedValue({ structuredContent: { photos: [photo] } });
    const generate = vi
      .fn()
      .mockResolvedValueOnce(call(read.name, { query: "pottery studio" }))
      .mockResolvedValueOnce(call(write.name, args));
    const result = await generateAgentWithTools(
      JSON.stringify({
        request: "Write for LinkedIn and X with a stock photo",
        scheduler: {
          connections: [
            { id, provider: "linkedin", status: "active" },
            { id: other, provider: "twitter", status: "active" },
          ],
        },
      }),
      context,
      "rules",
      {},
      {
        tools: new Map([
          [read.name, read],
          [write.name, write],
        ]),
        generate,
      },
    );
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ arguments: args, stockPhoto: photo });
    expect(write.execute).not.toHaveBeenCalled();
    expect(read.execute).toHaveBeenCalledTimes(1);
  });
  it("rejects invented stock images and unknown destinations", async () => {
    const write = tool("create_social_post", false);
    write.inputSchema = z.object({}).passthrough();
    const generate = vi
      .fn()
      .mockResolvedValueOnce(call(write.name, args))
      .mockResolvedValueOnce(reply);
    expect(
      (
        await generateAgentWithTools(
          "{}",
          context,
          "rules",
          {},
          { tools: new Map([[write.name, write]]), generate },
        )
      ).actions,
    ).toEqual([]);
    expect(JSON.stringify(generate.mock.calls[1][0].input.observations)).toContain("Never invent");
    const unknown = vi
      .fn()
      .mockResolvedValueOnce(call(write.name, { ...args, stockPhoto: undefined }))
      .mockResolvedValueOnce(reply);
    expect(
      (
        await generateAgentWithTools(
          JSON.stringify({ scheduler: { connections: [] } }),
          context,
          "rules",
          {},
          { tools: new Map([[write.name, write]]), generate: unknown },
        )
      ).actions,
    ).toEqual([]);
    expect(write.execute).not.toHaveBeenCalled();
  });
  it("caps stock searches at one per turn, including different queries", async () => {
    const read = tool("search_stock_photos", true);
    read.inputSchema = z.object({ query: z.string() });
    const generate = vi
      .fn()
      .mockResolvedValueOnce(call(read.name, { query: "pottery" }))
      .mockResolvedValueOnce(call(read.name, { query: "ceramics" }))
      .mockResolvedValueOnce(reply);
    await generateAgentWithTools(
      "{}",
      context,
      "rules",
      {},
      { tools: new Map([[read.name, read]]), generate },
    );
    expect(read.execute).toHaveBeenCalledTimes(1);
  });
  it("persists one network's edit and schedule while preserving other captions and Auto DM settings", async () => {
    const write = tool("create_social_post", false);
    write.inputSchema = z.object({}).passthrough();
    mocks.tools.mockReturnValue(new Map([[write.name, write]]));
    const row = {
      id,
      user_id: id,
      message_id: id,
      status: "pending",
      tool_name: write.name,
      updated_at: revision,
      arguments: {
        ...args,
        stockPhoto: undefined,
        mode: "draft",
        providerSettings: { twitter: { custom: "preserved" } },
      },
    };
    database(row);
    const result = await editAgentPostAction(context, id, revision, {
      connectionId: id,
      body: "A better LinkedIn post",
    });
    expect(result.arguments?.connectionOverrides).toEqual({
      [id]: { bodyOverride: "A better LinkedIn post" },
      [other]: { bodyOverride: "A short X update" },
    });
    expect(result.arguments?.providerSettings).toEqual({ twitter: { custom: "preserved" } });
    expect(write.execute).not.toHaveBeenCalled();
    await expect(approveAgentAppAction(context, id, false, revision)).rejects.toThrow("changed");
    expect((await approveAgentAppAction(context, id, false, result.revision)).status).toBe(
      "completed",
    );
    expect(write.execute).toHaveBeenCalledWith(
      expect.objectContaining({ connectionOverrides: result.arguments?.connectionOverrides }),
    );
  });
  it("does not edit foreign, stale, completed or expired reviews", async () => {
    const write = tool("create_social_post", false);
    write.inputSchema = z.object({}).passthrough();
    mocks.tools.mockReturnValue(new Map([[write.name, write]]));
    for (const variant of [
      { user_id: "other" },
      { status: "completed" },
      { updated_at: "stale" },
    ]) {
      database({
        id,
        user_id: id,
        message_id: id,
        status: "pending",
        tool_name: write.name,
        arguments: args,
        ...variant,
      });
      await expect(
        editAgentPostAction(context, id, revision, { connectionId: id, body: "Changed" }),
      ).rejects.toThrow();
    }
    database(
      {
        id,
        user_id: id,
        message_id: id,
        status: "pending",
        tool_name: write.name,
        arguments: args,
      },
      false,
    );
    await expect(
      editAgentPostAction(context, id, revision, { connectionId: id, body: "Changed" }),
    ).rejects.toThrow("expired");
  });
});

it("attaches a private video card from a verified tool read", async () => {
  const read = tool("get_reel_production", true);
  vi.mocked(read.execute).mockResolvedValue({
    structuredContent: { production: { entryId: id } },
    content: [{ type: "text", text: "Ready" }],
  });
  const generate = vi.fn().mockResolvedValueOnce(call(read.name)).mockResolvedValueOnce(reply);
  const result = await generateAgentWithTools(
    "{}",
    context,
    "System",
    {},
    { tools: new Map([[read.name, read]]), generate },
  );
  expect(result.artifacts).toEqual([{ entryId: id }]);
  expect(read.execute).toHaveBeenCalledOnce();
});

it("rejects model-authored artifact metadata", async () => {
  await expect(
    generateAgentWithTools(
      "{}",
      context,
      "System",
      {},
      { tools: new Map(), generate: async () => ({ ...reply, artifacts: [{ entryId: id }] }) },
    ),
  ).rejects.toThrow(/Unrecognized key/);
});

it("loads the scoped LinkedIn skill before planning a post without an extra AI turn", async () => {
  const skill = tool("get_benny_skill", true);
  skill.inputSchema = z.object({ id: z.literal("linkedin-os"), workspaceId: z.uuid() });
  vi.mocked(skill.execute).mockResolvedValue({
    structuredContent: {
      skill: {
        id: "linkedin-os",
        instructions: "Use this creator's approved LinkedIn strategy.",
        customized: true,
      },
    },
    content: [],
  });
  const generate = vi.fn(async (request) => {
    expect(skill.execute).toHaveBeenCalledWith({ id: "linkedin-os", workspaceId: id });
    expect(JSON.stringify(request.input.observations)).toContain(
      "this creator's approved LinkedIn strategy",
    );
    return reply;
  });
  await generateAgentWithTools(
    JSON.stringify({ request: "Write a LinkedIn post about my launch", workspaceId: "forged" }),
    context,
    "System",
    {},
    { tools: new Map([[skill.name, skill]]), generate },
  );
  expect(generate).toHaveBeenCalledOnce();
  expect(skill.execute).toHaveBeenCalledOnce();
});
it("does not load the LinkedIn workflow for unrelated requests or account settings", async () => {
  const skill = tool("get_benny_skill", true);
  for (const request of [
    "Write an Instagram caption",
    "Reconnect my LinkedIn account",
    "What are LinkedIn's settings?",
  ])
    await generateAgentWithTools(
      JSON.stringify({ request }),
      context,
      "System",
      {},
      { tools: new Map([[skill.name, skill]]), generate: async () => reply },
    );
  expect(skill.execute).not.toHaveBeenCalled();
});
it("keeps a failed skill read from triggering providers, writes or a remote fallback", async () => {
  const skill = tool("get_benny_skill", true);
  vi.mocked(skill.execute).mockRejectedValue(new Error("Unavailable"));
  const write = tool("create_social_post", false);
  const generate = vi.fn(async (request) => {
    expect(JSON.stringify(request.input.observations)).toContain("could not be loaded");
    return reply;
  });
  await generateAgentWithTools(
    JSON.stringify({ request: "Review my LinkedIn post" }),
    context,
    "System",
    {},
    {
      tools: new Map([
        [skill.name, skill],
        [write.name, write],
      ]),
      generate,
    },
  );
  expect(generate).toHaveBeenCalledOnce();
  expect(write.execute).not.toHaveBeenCalled();
});
