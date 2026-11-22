import { describe, expect, it, vi } from "vitest";
import { BENNY_SKILLS, bennySkillInput } from "./benny-skills";
import { createBentoAppTools, defaultBentoMcpOperations } from "./mcp.server";

describe("shared Benny skills", () => {
  it("preloads fourteen workflows whose tool references exist in the real app registry", () => {
    const tools = createBentoAppTools(
      { userId: "workspace", accessToken: "test", supabase: {} } as Parameters<
        typeof createBentoAppTools
      >[0],
      "https://app.bento.surf",
    );
    expect(BENNY_SKILLS).toHaveLength(14);
    expect(new Set(BENNY_SKILLS.map((skill) => skill.uri)).size).toBe(14);
    for (const skill of BENNY_SKILLS)
      for (const name of skill.tools) expect(tools.has(name), name).toBe(true);
    expect(tools.get("list_benny_skills")?.readOnly).toBe(true);
    expect(tools.get("get_benny_skill")?.readOnly).toBe(true);
  });
  it("saves customizations as scoped, creator-confirmed skill instructions", () => {
    expect(bennySkillInput(BENNY_SKILLS[0], "My workflow")).toMatchObject({
      content: "My workflow",
      sourceRef: "benny:skill:trend-discovery",
      tags: ["skill"],
      provenance: "creator",
      status: "confirmed",
    });
  });
});

it("serves the LinkedIn adaptation through the real scoped MCP tool", async () => {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const readWorkspaceData = vi.fn().mockResolvedValue({ collection: "brain_items", items: [] });
  const tools = createBentoAppTools(
    { userId: workspaceId, accessToken: "fixture", supabase: {} } as Parameters<
      typeof createBentoAppTools
    >[0],
    "https://app.test.bento.surf",
    { ...defaultBentoMcpOperations, readWorkspaceData },
  );
  const skill = tools.get("get_benny_skill")!;
  const result = await skill.execute({ id: "linkedin-os", workspaceId });
  expect(result.structuredContent).toMatchObject({
    workspaceId,
    skill: { id: "linkedin-os", customized: false },
  });
  expect(JSON.stringify(result.structuredContent)).toContain("CPIO");
  expect(readWorkspaceData).toHaveBeenCalledWith(
    expect.objectContaining({ userId: workspaceId }),
    expect.objectContaining({ collection: "brain_items" }),
  );
  readWorkspaceData.mockClear();
  await expect(
    skill.execute({ id: "linkedin-os", workspaceId: "00000000-0000-4000-8000-000000000002" }),
  ).rejects.toThrow("Workspace is unavailable");
  expect(readWorkspaceData).not.toHaveBeenCalled();
});
