import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NewsletterDocument } from "./NewsletterDocument";

describe("NewsletterDocument", () => {
  it("renders newsletter blocks and keeps unsafe URLs inert", () => {
    render(
      <NewsletterDocument
        subject="Launch day"
        previewText="A first look"
        content={[
          { id: "1", type: "heading", text: "Launch day" },
          { id: "2", type: "paragraph", text: "We are live." },
          { id: "3", type: "image", url: "javascript:alert(1)", alt: "Unsafe cover" },
          { id: "4", type: "button", label: "Unsafe action", url: "data:text/html,bad" },
          { id: "5", type: "button", label: "Read more", url: "/issues/launch-day" },
          { id: "6", type: "social", label: "Follow us", url: "https://example.com/bento" },
          { id: "7", type: "image", url: "https://127.0.0.1/private", alt: "Private image" },
          { id: "8", type: "button", label: "Backslash action", url: "/\\evil.example" },
        ]}
      />,
    );

    expect(screen.getByRole("article")).toHaveTextContent("Launch day");
    expect(screen.queryByRole("img", { name: "Unsafe cover" })).toBeNull();
    expect(screen.getByText("Unsafe cover")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Unsafe action" })).toBeNull();
    expect(screen.queryByRole("img", { name: "Private image" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Backslash action" })).toBeNull();
    expect(screen.getByRole("link", { name: "Read more" })).toHaveAttribute(
      "href",
      "/issues/launch-day",
    );
    expect(screen.getByRole("link", { name: "Follow us" })).toHaveAttribute(
      "href",
      "https://example.com/bento",
    );
  });
});
