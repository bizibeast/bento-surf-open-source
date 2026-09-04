import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { NewsletterContentBlock } from "@/lib/newsletter";
import { NewsletterCanvas } from "./NewsletterCanvas";

function Harness() {
  const [content, setContent] = useState<NewsletterContentBlock[]>([
    { id: "heading", type: "heading", text: "A clear headline" },
    { id: "body", type: "paragraph", text: "Write directly on the canvas." },
  ]);
  return <NewsletterCanvas content={content} onChange={setContent} products={[]} />;
}

describe("NewsletterCanvas", () => {
  it("edits, duplicates, and keyboard-reorders content on the visual canvas", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByLabelText("Paragraph text 2"));
    await user.type(screen.getByLabelText("Paragraph text 2"), " More detail.");
    expect(screen.getByLabelText("Paragraph text 2")).toHaveValue(
      "Write directly on the canvas. More detail.",
    );

    await user.click(screen.getByRole("button", { name: "Duplicate paragraph 2" }));
    expect(screen.getAllByDisplayValue("Write directly on the canvas. More detail.")).toHaveLength(
      2,
    );
    await user.click(screen.getByRole("button", { name: "Move paragraph 2 up" }));
    expect(screen.getByLabelText("Paragraph text 1")).toHaveValue(
      "Write directly on the canvas. More detail.",
    );
  });

  it("adds content from one insertion menu and edits selected block style", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Add content" }));
    await user.click(screen.getByRole("menuitem", { name: "Add quote" }));
    expect(screen.getByLabelText("Quote text 3")).toBeVisible();

    await user.click(screen.getByLabelText("Quote text 3"));
    expect(screen.getByRole("complementary", { name: "Block style" })).toBeVisible();
    await user.clear(screen.getByLabelText("Block background"));
    await user.type(screen.getByLabelText("Block background"), "#fff4ea");
    expect(screen.getByTestId("newsletter-block-quote")).toHaveStyle({
      backgroundColor: "#fff4ea",
    });
  });

  it("renders one seamless document with Notion-style hover controls", () => {
    render(
      <NewsletterCanvas
        content={[
          {
            id: "section",
            type: "section",
            layout: "two-equal",
            columns: [
              [{ id: "left", type: "paragraph", text: "Left" }],
              [{ id: "right", type: "quote", text: "Right" }],
            ],
          },
        ]}
        onChange={() => undefined}
        products={[]}
        presentation={{
          accentColor: "#3478f6",
          backgroundColor: "#f6f7fa",
          headingStyle: "serif",
          density: "comfortable",
          contentWidth: 640,
        }}
      />,
    );

    expect(screen.getByTestId("newsletter-editor-document")).toHaveClass("px-5", "sm:px-8");
    expect(screen.getByTestId("newsletter-block-section")).not.toHaveClass(
      "border",
      "bg-white",
      "px-5",
      "outline",
    );
    expect(screen.getByTestId("newsletter-block-section")).toHaveClass("bg-[#3478f6]/[0.025]");
    expect(screen.getByRole("button", { name: "Add content" })).toHaveClass("whitespace-nowrap");
    expect(screen.getByRole("button", { name: "Drag section 1" }).parentElement).toHaveClass(
      "right-20",
      "-top-9",
      "flex-row",
      "sm:-left-11",
      "sm:right-auto",
      "sm:top-0",
      "sm:flex-col",
    );
    expect(screen.getByTestId("newsletter-editor-document")).toHaveStyle({ overflow: "visible" });
    for (const column of screen.getAllByTestId("newsletter-editor-column")) {
      expect(column).not.toHaveClass("border-dashed", "p-3");
    }
  });
});
