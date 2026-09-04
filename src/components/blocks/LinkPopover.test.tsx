import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LinkPopover } from "./LinkPopover";

vi.mock("@/lib/link-metadata.functions", () => ({
  fetchLinkMetadata: vi.fn().mockResolvedValue({
    url: "https://product.example/",
    title: "Example Product",
    favicon: "https://product.example/favicon.svg",
    color: "#007cff",
  }),
}));

describe("LinkPopover", () => {
  it("keeps the quick-link input inside the phone viewport", () => {
    render(<LinkPopover onAdd={vi.fn()} buttonClassName="" />);

    fireEvent.click(screen.getByRole("button", { name: "Add link" }));

    expect(screen.getByPlaceholderText("Enter Link").parentElement?.parentElement).toHaveClass(
      "fixed",
      "inset-x-2",
      "sm:absolute",
    );
  });

  it.each([
    "https://www.youtube.com/watch?v=M7lc1UVf-VE",
    "https://youtu.be/M7lc1UVf-VE?t=10",
    "https://youtube.com/shorts/M7lc1UVf-VE",
  ])("adds a YouTube video URL as a video tile: %s", async (url) => {
    const onAdd = vi.fn();
    render(<LinkPopover onAdd={onAdd} buttonClassName="" />);

    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    fireEvent.change(screen.getByPlaceholderText("Enter Link"), { target: { value: url } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(onAdd).toHaveBeenCalledWith({
        type: "video",
        content: {
          embedProvider: "youtube",
          originalUrl: url,
          url: "https://www.youtube.com/embed/M7lc1UVf-VE?playsinline=1&rel=0",
        },
        w: 4,
        h: 2,
      }),
    );
  });

  it("keeps a YouTube channel URL as a channel tile", async () => {
    const onAdd = vi.fn();
    render(<LinkPopover onAdd={onAdd} buttonClassName="" />);

    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    fireEvent.change(screen.getByPlaceholderText("Enter Link"), {
      target: { value: "https://youtube.com/@bento" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(onAdd).toHaveBeenCalledWith({
        type: "social_link",
        content: {
          platform: "youtube",
          handle: "bento",
          url: "https://youtube.com/@bento",
        },
        w: 1,
        h: 1,
      }),
    );
  });

  it("captures and persists website color for links added from the bar", async () => {
    const onAdd = vi.fn();
    render(<LinkPopover onAdd={onAdd} buttonClassName="" />);

    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    fireEvent.change(screen.getByPlaceholderText("Enter Link"), {
      target: { value: "product.example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(onAdd).toHaveBeenCalledWith({
        type: "generic_link",
        content: {
          title: "Example Product",
          url: "https://product.example/",
          description: "",
          color: "#007cff",
        },
        cover_url: "https://product.example/favicon.svg",
        w: 2,
        h: 1,
      }),
    );
  });
});
