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
  agentActionErrorMessage,
  agentEntityLabels,
  AGENT_TOOL_STEP_LIMIT,
} from "./content-agent-tools.server";
import type { BentoAppTool } from "./mcp.server";
const id = "00000000-0000-4000-8000-000000000001";
const context = { userId: id, accessToken: "user-jwt", supabase: {} as any };
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
function database(row: any, messageExists = true) {
  mocks.from.mockImplementation((table: string) => {
    const filters: Record<string, unknown> = {};
    let update: any;
    const q: any = {
      select: () => q,
      eq: (k: string, v: unknown) => {
        filters[k] = v;
        return q;
      },
      gt: () => q,
      update: (v: any) => {
        update = v;
        return q;
      },
      maybeSingle: async () => run(),
      then: (resolve: any) => Promise.resolve(run()).then(resolve),
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
      approveAgentAppAction(context, id),
      approveAgentAppAction(context, id),
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
    await expect(approveAgentAppAction(context, id)).rejects.toThrow("unavailable");
    database(
      { id, user_id: id, message_id: id, status: "pending", tool_name: "save", arguments: {} },
      false,
    );
    await expect(approveAgentAppAction(context, id)).rejects.toThrow("expired");
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
    expect((await approveAgentAppAction(context, id, true)).status).toBe("dismissed");
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
    expect((await approveAgentAppAction(context, id)).message).toContain("permission");
    await approveAgentAppAction(context, id);
    expect(write.execute).toHaveBeenCalledOnce();
  });
});
