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
  it("edits visible prose and saves automatically without an Edit or Save step", async () => {
    const onSave = vi.fn();
    render(<ContentDocument label="Instructions" value="A rule" onSave={onSave} />);
    expect(screen.getByRole("button", { name: "Edit Instructions" })).toBeVisible();
    const editor = screen.getByRole("textbox", { name: "Instructions" });
    expect(editor).toHaveTextContent("A rule");
    editor.innerHTML = "<h3>Voice</h3><p>Write <strong>clearly</strong>.</p>";
    fireEvent.input(editor);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("## Voice\n\nWrite **clearly**."));
  });
  it("preserves unsaved edits through a refetch and retries a failed save", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValue(undefined);
    const { rerender } = render(
      <ContentDocument label="Instructions" value="A rule" onSave={onSave} />,
    );
    const editor = screen.getByRole("textbox", { name: "Instructions" });
    editor.innerHTML = "<p>Corrected rule</p>";
    fireEvent.input(editor);
    fireEvent.blur(editor);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Offline"));
    rerender(<ContentDocument label="Instructions" value="A stale rule" onSave={onSave} />);
    expect(editor).toHaveTextContent("Corrected rule");
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(onSave).toHaveBeenLastCalledWith("Corrected rule");
  });
  it("serializes saves and follows an in-flight request with the latest text", async () => {
    let finish!: () => void;
    const onSave = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    render(<ContentDocument label="My Human" value="Original" onSave={onSave} />);
    const editor = screen.getByRole("textbox", { name: "My Human" });
    editor.innerHTML = "<p>First edit</p>";
    fireEvent.input(editor);
    fireEvent.blur(editor);
    editor.innerHTML = "<p>Second edit</p>";
    fireEvent.input(editor);
    fireEvent.blur(editor);
    expect(onSave).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave).toHaveBeenLastCalledWith("Second edit");
  });
});
