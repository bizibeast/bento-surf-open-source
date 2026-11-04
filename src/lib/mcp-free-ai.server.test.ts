import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("./provider-budget.server");

const calls = vi.hoisted(() => ({
  rpc: vi.fn(),
  provider: vi.fn(),
}));

vi.mock("./request-security.server", async () => ({
  ...(await vi.importActual<typeof import("./request-security.server")>(
    "./request-security.server",
  )),
  enforceRequestRateLimit: vi.fn(async () => undefined),
}));

const runProvider = vi.fn(async () => {
  const { reserveAiProviderUsage } = await import("./provider-budget.server");
  await reserveAiProviderUsage(100, {
    provider: "workers-ai",
    model: "@cf/openai/gpt-oss-20b",
    publicTool: true,
    client: { rpc: calls.rpc },
  });
  calls.provider();
  return { outputs: ["A short bio"], provider: "workers-ai" as const };
});

import { runMcpFreeAiTool } from "./mcp-free-tools.server";

const acceptedWorkspace = "00000000-0000-4000-8000-000000000001";
const deniedWorkspace = "00000000-0000-4000-8000-000000000002";
const input = {
  toolSlug: "instagram-bio-generator",
  platform: "Instagram",
  values: { role: "Creator strategist" },
};

beforeEach(() => {
  calls.rpc
    .mockReset()
    .mockImplementation(async (_name: string, args: { p_workspace_id: string }) => ({
      data:
        args.p_workspace_id === deniedWorkspace
          ? { allowed: false, reason: "workspace_daily", retry_at: "2026-10-30T00:00:00Z" }
          : { allowed: true, reservation_id: "10000000-0000-4000-8000-000000000001" },
      error: null,
    }));
  calls.provider.mockClear();
});

describe("MCP free AI workspace budget", () => {
  it("keeps concurrent workspaces isolated and stops a denied call before the provider", async () => {
    const [accepted, denied] = await Promise.allSettled([
      runMcpFreeAiTool(acceptedWorkspace, input, runProvider),
      runMcpFreeAiTool(deniedWorkspace, input, runProvider),
    ]);

    expect(accepted).toMatchObject({ status: "fulfilled", value: { outputs: ["A short bio"] } });
    expect(denied).toMatchObject({ status: "rejected", reason: { name: "ProviderBudgetError" } });
    expect(calls.provider).toHaveBeenCalledOnce();
    expect(
      calls.rpc.mock.calls.map(([name, args]) => [name, args.p_workspace_id, args.p_public_tool]),
    ).toEqual(
      expect.arrayContaining([
        ["reserve_ai_provider_usage", acceptedWorkspace, true],
        ["reserve_ai_provider_usage", deniedWorkspace, true],
      ]),
    );
  });
});
