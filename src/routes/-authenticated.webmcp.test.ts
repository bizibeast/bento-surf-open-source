import { describe, expect, it, vi } from "vitest";
import { createAuthenticatedWebMcpTools } from "@/lib/webmcp-tools";
import {
  authenticatedWebMcpToolNames,
  createOpenWorkspaceWebMcpTool,
  WEBMCP_TOOLS_BY_ROUTE,
} from "./_authenticated";

describe("authenticated WebMCP route coverage", () => {
  it("maps every creator workspace to registered shared tools", () => {
    expect(Object.keys(WEBMCP_TOOLS_BY_ROUTE).sort()).toEqual(
      [
        "analytics",
        "auto-dms",
        "automations",
        "bookings",
        "calendar",
        "community",
        "dashboard",
        "earn",
        "email-marketing",
        "home",
        "link",
        "mcp",
        "onboarding",
        "post-scheduler",
        "products",
        "scheduler",
        "settings",
        "social-insights",
        "store",
      ].sort(),
    );

    const registered = new Set(createAuthenticatedWebMcpTools(vi.fn()).map((tool) => tool.name));
    for (const toolNames of Object.values(WEBMCP_TOOLS_BY_ROUTE)) {
      for (const toolName of toolNames) expect(registered.has(toolName), toolName).toBe(true);
    }
  });

  it("keeps shared mutations scoped to the current workspace", () => {
    expect(authenticatedWebMcpToolNames("/store")).toEqual(
      new Set(["get_bento_overview", ...WEBMCP_TOOLS_BY_ROUTE.store]),
    );
    expect(authenticatedWebMcpToolNames("/auto-dms/instagram")).toEqual(
      new Set(["get_bento_overview", ...WEBMCP_TOOLS_BY_ROUTE["auto-dms"]]),
    );
    expect(authenticatedWebMcpToolNames("/email-marketing")).toEqual(
      new Set(["get_bento_overview", "manage_audience"]),
    );
    expect(authenticatedWebMcpToolNames("/admin")).toEqual(new Set(["get_bento_overview"]));
  });

  it("requires approval and honors cancellation before workspace navigation", async () => {
    const openWorkspace = vi.fn().mockResolvedValue(undefined);
    const tool = createOpenWorkspaceWebMcpTool(openWorkspace);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    await expect(
      tool.execute({ workspace: "store" }, { signal: new AbortController().signal }),
    ).rejects.toThrow("did not approve");
    expect(openWorkspace).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    const controller = new AbortController();
    controller.abort();
    await expect(
      tool.execute({ workspace: "store" }, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(openWorkspace).not.toHaveBeenCalled();

    await expect(
      tool.execute({ workspace: "store" }, { signal: new AbortController().signal }),
    ).resolves.toMatchObject({ structuredContent: { path: "/store" } });
    expect(openWorkspace).toHaveBeenCalledWith("/store");
  });
});
