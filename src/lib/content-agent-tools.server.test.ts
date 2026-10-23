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
describe("Agent tool execution", () => {
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
