import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
}));

import { McpSetupPage } from "./mcp.setup";

describe("MCP setup guide", () => {
  it("switches client instructions and capability examples", () => {
    render(<McpSetupPage />);

    expect(screen.getByRole("heading", { name: "Your Bento. In any AI agent." })).toBeVisible();
    expect(screen.getAllByText("http://localhost:8080/mcp").length).toBeGreaterThan(0);
    expect(screen.getByRole("tablist", { name: "AI client" })).toHaveClass("px-[3px]", "pt-[3px]");
    expect(screen.getByRole("tab", { name: "ChatGPT" })).toHaveClass(
      "border-[#3478f6]",
      "bg-transparent",
      "text-[#3478f6]",
    );
    expect(screen.getByRole("tab", { name: "ChatGPT" })).not.toHaveClass(
      "bg-[#eef5ff]/90",
      "shadow-[inset_0_0_0_1px_rgba(52,120,246,0.45)]",
    );
    expect(screen.getAllByTestId("setup-glass")).toHaveLength(3);
    for (const glass of screen.getAllByTestId("setup-glass")) {
      expect(glass).toHaveClass(
        "h-36",
        "overflow-hidden",
        "bg-white/[0.075]",
        "backdrop-blur-xl",
        "border-white/[0.14]",
      );
    }
    for (const content of screen.getAllByTestId("setup-step-content")) {
      expect(content).toHaveClass("mt-auto", "pt-7");
    }

    fireEvent.click(screen.getByRole("tab", { name: "Other" }));
    expect(screen.getByRole("tab", { name: "Other" })).toHaveAttribute("data-mcp-client-tab");
    expect(screen.getByRole("tab", { name: "Other" })).toHaveClass("last:!rounded-tr-[24px]");

    fireEvent.click(screen.getByRole("tab", { name: "Claude Code" }));
    expect(screen.getByRole("tabpanel", { name: "Claude Code setup" })).toHaveTextContent(
      "claude mcp add --transport http bento",
    );

    fireEvent.click(screen.getByRole("tab", { name: /^Store/ }));
    expect(screen.getByRole("tabpanel", { name: "Store" })).toHaveTextContent(
      "Create a $29 digital product",
    );
  });
});
