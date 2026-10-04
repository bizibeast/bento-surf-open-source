import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContentDocument, ContentMarkdown } from "./ContentDocument";

describe("Content documents", () => {
  it("renders headings, lists, links, and code as safe prose", () => {
    const { container } = render(
      <ContentMarkdown
        text={
          "## A lesson\n\n**What I Share:**\n- **Proof**\n- *A detail*\n\n[Source](https://example.com/post)\n\n```js\nconst x = 1;\n\nconsole.log(x);\n```\n\n<script>alert(1)</script>"
        }
      />,
    );
    expect(screen.getByRole("heading", { name: "A lesson" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Source" })).toHaveAttribute(
      "href",
      "https://example.com/post",
    );
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("pre")).toHaveTextContent("console.log(x)");
    expect(container.querySelector("script")).toBeNull();
  });
  it("keeps edits after a failed save and supports undo and redo", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("Offline"));
    render(<ContentDocument label="Instructions" value="A rule" onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Instructions" }));
    fireEvent.change(screen.getByLabelText("Instructions"), {
      target: { value: "Corrected rule" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByLabelText("Instructions")).toHaveValue("A rule");
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Offline"));
    expect(screen.getByLabelText("Instructions")).toHaveValue("Corrected rule");
    expect(onSave).toHaveBeenCalledWith("Corrected rule");
  });
});
