import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentClientIntegrationCard } from "./AgentClientIntegrationCard";

const mocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: mocks }));
const mcpUrl = "https://workspace.example/mcp";

beforeEach(() => vi.clearAllMocks());

describe("AI client integrations", () => {
  it.each(["chatgpt", "claude", "cursor", "grok"] as const)(
    "copies the configured endpoint for %s without claiming a completed connection",
    async (client) => {
      const user = userEvent.setup();
      const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
      render(<AgentClientIntegrationCard client={client} mcpUrl={mcpUrl} />);
      await user.click(screen.getByRole("button", { name: /^Set up/ }));
      await user.click(screen.getByRole("button", { name: "Copy" }));
      const copied = copy.mock.calls[0][0];
      if (client === "cursor") {
        expect(JSON.parse(copied)).toEqual({ mcpServers: { bento: { url: mcpUrl } } });
      } else {
        expect(copied).toBe(mcpUrl);
      }
      expect(screen.queryByText("Connected", { exact: true })).not.toBeInTheDocument();
      expect(screen.getByText(/does not send proactive messages/)).toBeInTheDocument();
      expect(mocks.success).toHaveBeenCalled();
    },
  );

  it("separates Grok Bot browser setup from Grok web OAuth and copies an approval-first prompt", async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(<AgentClientIntegrationCard client="grok" mcpUrl={mcpUrl} />);
    await user.click(screen.getByRole("button", { name: /^Set up/ }));
    expect(screen.getByRole("link", { name: "Open Grok" })).toHaveAttribute(
      "href",
      "https://grok.com/connectors",
    );
    await user.click(screen.getByRole("button", { name: "Grok Bot" }));
    expect(screen.queryByText("Bento MCP URL")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open Grok" })).not.toBeInTheDocument();
    expect(screen.getByText(/marketplace listing is not currently provided/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy starter prompt" }));
    expect(copy).toHaveBeenCalledWith(expect.stringContaining("/content?tab=agent"));
    expect(copy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Do not publish, schedule, or purchase anything without my approval.",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Grok web" }));
    expect(screen.getByText("Bento MCP URL")).toBeInTheDocument();
  });

  it("reports clipboard failure and keeps the configuration available to select", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Denied"));
    render(<AgentClientIntegrationCard client="claude" mcpUrl={mcpUrl} />);
    await user.click(screen.getByRole("button", { name: /^Set up/ }));
    await user.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    expect(mocks.success).not.toHaveBeenCalled();
    expect(screen.getByText(mcpUrl)).toBeVisible();
  });
});
