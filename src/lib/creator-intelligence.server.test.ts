import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { from, hasPlanEntitlement } = vi.hoisted(() => ({
  from: vi.fn(),
  hasPlanEntitlement: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from } }));
vi.mock("./plan.server", () => ({ hasPlanEntitlement }));

import { registerCreatorIntelligenceMcpTool } from "./creator-intelligence-mcp.server";
import {
  formatCreatorIntelligenceContext,
  getCreatorIntelligence,
  saveCreatorIntelligencePreferences,
} from "./creator-intelligence.server";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const otherWorkspaceId = "00000000-0000-4000-8000-000000000002";

function table(data: unknown = null) {
  const result = Promise.resolve({ data, error: null });
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
    order: vi.fn(),
    gte: vi.fn(),
    limit: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    maybeSingle: vi.fn().mockReturnValue(result),
    then: result.then.bind(result),
  };
  for (const method of [
    query.select,
    query.eq,
    query.in,
    query.order,
    query.gte,
    query.limit,
    query.upsert,
    query.update,
  ])
    method.mockReturnValue(query);
  return query;
}

describe("creator intelligence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("BENTO_V2_CREATOR_INTELLIGENCE_ENABLED", "true");
    hasPlanEntitlement.mockResolvedValue(true);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("checks rollout and entitlements before loading or saving any creator data", async () => {
    vi.stubEnv("BENTO_V2_CREATOR_INTELLIGENCE_ENABLED", "false");
    await expect(getCreatorIntelligence({ userId: workspaceId })).resolves.toBeNull();
    expect(hasPlanEntitlement).not.toHaveBeenCalled();

    vi.stubEnv("BENTO_V2_CREATOR_INTELLIGENCE_ENABLED", "true");
    hasPlanEntitlement.mockResolvedValue(false);
    await expect(getCreatorIntelligence({ userId: workspaceId })).resolves.toBeNull();
    await expect(saveCreatorIntelligencePreferences(workspaceId, {})).rejects.toThrow(
      "unavailable",
    );
    expect(hasPlanEntitlement).toHaveBeenCalledWith(workspaceId, "discover");
    expect(from).not.toHaveBeenCalled();
  });

  it("reads only selected workspace context and excludes private sources and credentials", async () => {
    const profile = table({
      goal: "reach_growth",
      niche_keywords: ["Recipes"],
      language: "en",
      region: "global",
      intelligence_preferences: { audience: "First-time bakers", voice: "Plain and specific" },
    });
    const brain = table([
      {
        kind: "profile",
        title: "Personal name",
        content: "Private bio",
        provenance: "creator",
        status: "confirmed",
      },
      {
        kind: "instruction",
        title: "Writing voice",
        content: "Superseded voice",
        provenance: "creator",
        status: "confirmed",
      },
      {
        kind: "instruction",
        title: "Educational Reel style",
        content: "Use readable captions and calm pacing.",
        provenance: "creator",
        status: "confirmed",
        tags: ["creative-preference", "reel"],
      },
      {
        kind: "instruction",
        title: "Private integration",
        content: "Private meeting source",
        provenance: "integration",
        status: "confirmed",
        locked: true,
      },
    ]);
    const brand = table({
      branding: { heroPhotoId: otherWorkspaceId, accentColor: "#123456" },
      upstreamToken: "private credential",
    });
    const insights = table([
      {
        provider: "linkedin",
        content_type: "carousel",
        published_at: "2026-11-01T00:00:00Z",
        fetched_at: "2026-11-02T00:00:00Z",
        views: null,
        impressions: 42,
        engagements: 0,
        caption: "Private caption",
        remote_post_url: "https://example.test/private",
      },
    ]);
    const tables: Record<string, ReturnType<typeof table>> = {
      creator_content_profiles: profile,
      creator_brain_items: brain,
      content_agent_preferences: brand,
      social_content_insights: insights,
    };
    from.mockImplementation((name) => tables[name]);

    const intelligence = await getCreatorIntelligence({
      userId: workspaceId,
      query: "Plan a LinkedIn post",
    });
    expect(intelligence).toMatchObject({
      brain: {
        hasConfirmedProfile: true,
        writingVoice: null,
        creativePreferences: [
          {
            title: "Educational Reel style",
            content: "Use readable captions and calm pacing.",
            kind: "reel",
          },
        ],
      },
      brand: { accentColor: "#123456" },
      social: {
        posts: [{ platform: "linkedin", impressions: 42, views: null, engagements: 0 }],
      },
    });
    for (const query of Object.values(tables)) {
      expect(query.eq).toHaveBeenCalledWith("user_id", workspaceId);
    }
    const serialized = JSON.stringify(intelligence);
    for (const privateValue of [
      "Personal name",
      "Private bio",
      "Superseded voice",
      "Private meeting source",
      "Private caption",
      "https://example",
      "private credential",
      "heroPhotoId",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(formatCreatorIntelligenceContext(intelligence)).toContain(
      '"writingVoice":"Plain and specific"',
    );
    expect(insights.gte).toHaveBeenCalledWith("published_at", expect.any(String));
    expect(insights.in).toHaveBeenCalledWith("provider", ["linkedin"]);
    expect(insights.limit).toHaveBeenCalledWith(8);
  });

  it("omits analytics on an unrelated query and skips unverified or private voice inputs", async () => {
    const tables: Record<string, ReturnType<typeof table>> = {
      creator_content_profiles: table(),
      creator_brain_items: table([
        {
          kind: "profile",
          title: "My Human",
          content: "Stale",
          provenance: "link",
          status: "confirmed",
        },
        {
          kind: "instruction",
          title: "Writing voice",
          content: "External voice",
          provenance: "integration",
          status: "confirmed",
          locked: true,
        },
        {
          kind: "instruction",
          title: "Writing voice",
          content:
            "Writing voice\nUse short sentences. api_key=Secret123 sk-or-v1-ABCDEF1234567890",
          provenance: "creator",
          tags: ["canonical-voice"],
          status: "confirmed",
        },
      ]),
      content_agent_preferences: table(),
    };
    from.mockImplementation((name) => tables[name]);
    const intelligence = await getCreatorIntelligence({
      userId: workspaceId,
      query: "Hello there",
    });
    expect(intelligence?.brain.hasConfirmedProfile).toBe(false);
    expect(intelligence?.social).toBeNull();
    expect(from).not.toHaveBeenCalledWith("social_content_insights");
    const context = formatCreatorIntelligenceContext(intelligence);
    expect(context).toContain("Use short sentences.");
    for (const excluded of [
      "Stale",
      "External voice",
      "Secret123",
      "sk-or-v1",
      "consistent_publishing",
    ])
      expect(context).not.toContain(excluded);
  });

  it("sets or clears only explicit preferences without replacing prior profile columns", async () => {
    const profile = table();
    from.mockReturnValue(profile);
    await expect(
      saveCreatorIntelligencePreferences(workspaceId, { voice: " Concise " }),
    ).resolves.toEqual({ voice: "Concise" });
    expect(profile.upsert).toHaveBeenCalledWith(
      { user_id: workspaceId, intelligence_preferences: { voice: "Concise" } },
      { onConflict: "user_id", defaultToNull: false },
    );
    await expect(saveCreatorIntelligencePreferences(workspaceId, {})).resolves.toEqual({});
    expect(profile.update).toHaveBeenCalledWith({ intelligence_preferences: {} });
    expect(profile.eq).toHaveBeenCalledWith("user_id", workspaceId);
  });

  it("exposes a read-only MCP tool and requires verified workspace selection", async () => {
    const registerTool = vi.fn();
    const resolve = vi.fn().mockRejectedValue(new Error("Forbidden workspace"));
    const auth = { extra: { userId: workspaceId }, token: "token", clientId: "mcp", scopes: [] };

    vi.stubEnv("BENTO_V2_CREATOR_INTELLIGENCE_ENABLED", "false");
    registerCreatorIntelligenceMcpTool({ registerTool }, auth, resolve);
    expect(registerTool).not.toHaveBeenCalled();

    vi.stubEnv("BENTO_V2_CREATOR_INTELLIGENCE_ENABLED", "true");
    registerCreatorIntelligenceMcpTool({ registerTool }, auth, resolve);
    const [name, tool, execute] = registerTool.mock.calls[0];
    expect(name).toBe("get_creator_intelligence");
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    await expect(execute({ workspaceId: otherWorkspaceId })).rejects.toThrow("Forbidden workspace");
    expect(resolve).toHaveBeenCalledWith(workspaceId, otherWorkspaceId);
    expect(from).not.toHaveBeenCalled();
  });
});
