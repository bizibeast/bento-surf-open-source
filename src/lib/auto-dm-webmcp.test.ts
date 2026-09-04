// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { autoDmWebMcpMedia, autoDmWebMcpSummary, createAutoDmWebMcpTools } from "./auto-dm-webmcp";

const automationId = "11111111-1111-4111-8111-111111111111";
const connectionId = "22222222-2222-4222-8222-222222222222";
const signal = () => new AbortController().signal;

const dashboard = {
  locked: false,
  plan: "creator",
  configured: true,
  webhookUrl: "https://private.example/webhook",
  connections: [
    {
      id: connectionId,
      handle: "creator",
      displayName: "Creator",
      ready: true,
      needsReconnect: false,
      readinessIssues: [],
      lastError: "provider secret detail",
      webhookFields: ["messages"],
      accessToken: "secret-token",
    },
  ],
  activity: [
    {
      id: "event-1",
      automationName: "Send the guide",
      eventType: "comment",
      senderLabel: "private-customer",
      matchedKeyword: "private-keyword",
      errorMessage: "raw provider error",
      status: "sent",
      createdAt: "2026-08-30T00:00:00.000Z",
    },
  ],
  workflows: [
    {
      id: "workflow-1",
      automationName: "Send the guide",
      senderLabel: "private-customer",
      status: "completed",
      emailCaptured: true,
      marketingConsent: true,
      capturedEmail: "buyer@example.com",
      createdAt: "2026-08-30T00:00:00.000Z",
      completedAt: "2026-08-30T00:01:00.000Z",
    },
  ],
};

describe("Auto-DM WebMCP tools", () => {
  it("projects bounded activity and media without private provider fields or URLs", () => {
    const output = JSON.stringify({
      workspace: autoDmWebMcpSummary("instagram", dashboard),
      media: autoDmWebMcpMedia([
        {
          id: "post-1",
          caption: "Public caption",
          mediaType: "IMAGE",
          imageUrl: "https://private.example/media.jpg",
          permalink: "https://instagram.com/p/private",
          timestamp: "2026-08-30T00:00:00.000Z",
        },
      ]),
    });

    expect(output).toContain("Public caption");
    expect(output).not.toMatch(
      /secret-token|private-customer|private-keyword|provider secret|raw provider|buyer@example|private\.example|instagram\.com/u,
    );
  });

  it("fails closed before writes and returns only allowlisted preflight checks", async () => {
    const preflight = vi.fn().mockResolvedValue({
      dashboard,
      checks: {
        officialMetaSubscription: true,
        requiredPermissions: true,
        connectionHealthy: true,
        workflowValid: true,
        verifiedAt: "2026-08-30T00:00:00.000Z",
        rawProviderResponse: "secret-response",
      },
    });
    const repairConnection = vi.fn().mockResolvedValue(dashboard);
    const onDashboard = vi.fn();
    const tools = createAutoDmWebMcpTools({
      platform: "instagram",
      loadDashboard: vi.fn().mockResolvedValue(dashboard),
      getMedia: vi.fn().mockResolvedValue([]),
      preflight,
      repairConnection,
      onDashboard,
    });
    const tool = tools.find((candidate) => candidate.name === "bento_run_auto_dm_preflight")!;
    vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);

    await expect(tool.execute({ automationId }, { signal: signal() })).rejects.toThrow(
      "did not approve",
    );
    expect(preflight).not.toHaveBeenCalled();

    const result = await tool.execute({ automationId }, { signal: signal() });
    expect(preflight).toHaveBeenCalledWith(automationId);
    expect(onDashboard).toHaveBeenCalledWith(dashboard);
    expect(JSON.stringify(result)).not.toContain("secret-response");
  });

  it("does not advertise a media tool for X, which has no media-scoped trigger", () => {
    const tools = createAutoDmWebMcpTools({
      platform: "twitter",
      loadDashboard: vi.fn().mockResolvedValue(dashboard),
      preflight: vi.fn().mockResolvedValue({ dashboard }),
      repairConnection: vi.fn().mockResolvedValue(dashboard),
      onDashboard: vi.fn(),
    });

    expect(tools.map((tool) => tool.name)).not.toContain("bento_get_auto_dm_media");
  });
});
