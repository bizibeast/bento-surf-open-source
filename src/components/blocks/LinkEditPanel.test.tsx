import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { LinkEditPanel } from "./LinkEditPanel";

beforeAll(() => {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

describe("LinkEditPanel Twitter appearance", () => {
  it("lets the creator switch a Twitter post from light to dark", () => {
    const onChange = vi.fn();
    render(
      <LinkEditPanel
        blockId="twitter-1"
        blockType="video"
        anchorRect={null}
        content={{
          embedProvider: "twitter",
          originalUrl: "https://x.com/bento/status/1234567890123456789",
          twitterTheme: "light",
        }}
        onChange={onChange}
        onClose={() => undefined}
        isCustomLink={false}
        tileW={4}
        tileH={2}
      />,
    );

    expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        twitterTheme: "dark",
        url: "https://platform.twitter.com/embed/Tweet.html?id=1234567890123456789&dnt=true&theme=dark",
      }),
    );
    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows a public X URL and repairs a legacy iframe URL when changing theme", () => {
    const onChange = vi.fn();
    render(
      <LinkEditPanel
        blockId="twitter-legacy"
        blockType="video"
        anchorRect={null}
        content={{
          embedProvider: "twitter",
          originalUrl:
            "https://platform.twitter.com/embed/Tweet.html?id=1234567890123456789&dnt=true&theme=light",
          url: "",
          twitterTheme: "light",
        }}
        onChange={onChange}
        onClose={() => undefined}
        isCustomLink={false}
        tileW={4}
        tileH={2}
      />,
    );

    expect(screen.getByDisplayValue("https://x.com/i/status/1234567890123456789")).toBeVisible();
    expect(screen.queryByText("Paste a supported public link to update this block.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        originalUrl: "https://x.com/i/status/1234567890123456789",
        twitterTheme: "dark",
        url: "https://platform.twitter.com/embed/Tweet.html?id=1234567890123456789&dnt=true&theme=dark",
      }),
    );
  });
});

describe("LinkEditPanel text heading size", () => {
  it("persists an H1–H6 heading level", () => {
    const onChange = vi.fn();
    render(
      <LinkEditPanel
        blockId="heading-1"
        blockType="heading"
        anchorRect={null}
        content={{ text: "Currently building", headingLevel: "h2" }}
        onChange={onChange}
        onClose={() => undefined}
        isCustomLink={false}
        tileW={4}
        tileH={1}
      />,
    );

    expect(screen.getByRole("button", { name: "H2" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "H4" }));

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        headingLevel: "h4",
      }),
    );
    expect(screen.getByRole("button", { name: "H4" })).toHaveAttribute("aria-pressed", "true");
  });

  it("persists a selected text color", () => {
    const onChange = vi.fn();
    render(
      <LinkEditPanel
        blockId="heading-1"
        blockType="heading"
        anchorRect={null}
        content={{ text: "Currently building" }}
        onChange={onChange}
        onClose={() => undefined}
        isCustomLink={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Text color" }));
    fireEvent.click(screen.getByRole("button", { name: "Use #d2474b text color" }));

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ textColor: "#d2474b" }));
  });
});

describe("LinkEditPanel image controls", () => {
  it("does not show CTA controls for image blocks", () => {
    render(
      <LinkEditPanel
        blockId="image-1"
        blockType="image"
        anchorRect={null}
        content={{
          url: "https://example.com/photo.jpg",
          linkUrl: "https://example.com",
          title: "A photo",
        }}
        onChange={() => undefined}
        onClose={() => undefined}
        isCustomLink={false}
        tileW={2}
        tileH={2}
      />,
    );

    expect(screen.getByRole("button", { name: "Image" })).toBeVisible();
    expect(screen.getByRole("button", { name: "URL" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "CTA" })).toBeNull();
    expect(screen.queryByText("Show CTA button")).toBeNull();
  });
});

describe("LinkEditPanel YouTube text tag", () => {
  it("lets the creator add an optional text tag to a YouTube video", () => {
    const onChange = vi.fn();
    render(
      <LinkEditPanel
        blockId="youtube-1"
        blockType="video"
        anchorRect={null}
        content={{
          embedProvider: "youtube",
          originalUrl: "https://youtu.be/M7lc1UVf-VE",
        }}
        onChange={onChange}
        onClose={() => undefined}
        isCustomLink={false}
        tileW={4}
        tileH={2}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Text tag" }));
    fireEvent.change(screen.getByPlaceholderText("Add a text tag"), {
      target: { value: "Watch now" },
    });

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: "Watch now",
      }),
    );
  });
});

describe("LinkEditPanel uploaded video controls", () => {
  it("supports replacing the file or URL and a text tag without link CTA controls", () => {
    const onChange = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <LinkEditPanel
          blockId="video-1"
          blockType="video"
          anchorRect={null}
          content={{ url: "https://cdn.example.com/old.mp4" }}
          onChange={onChange}
          onClose={() => undefined}
          isCustomLink={false}
          tileW={4}
          tileH={3}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Upload video")).toBeVisible();
    expect(screen.getByDisplayValue("https://cdn.example.com/old.mp4")).toBeVisible();
    expect(screen.queryByRole("button", { name: "CTA" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Description" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Text tag" }));
    fireEvent.change(screen.getByPlaceholderText("Add a text tag"), {
      target: { value: "Behind the scenes" },
    });

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Behind the scenes" }),
    );
  });
});

describe("LinkEditPanel Experience ordering", () => {
  it("lets the creator move an Experience entry earlier", () => {
    const onChange = vi.fn();
    render(
      <LinkEditPanel
        blockId="experience-1"
        blockType="experience"
        anchorRect={null}
        content={{
          items: [
            { id: "first", company: "Acme", logo: "https://cdn.bento.surf/acme.png" },
            { id: "second", company: "Beta", logo: "" },
          ],
        }}
        onChange={onChange}
        onClose={() => undefined}
        isCustomLink={false}
        tileW={2}
        tileH={2}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Beta/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move experience earlier" }));

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({ id: "second", company: "Beta" }),
          expect.objectContaining({ id: "first", company: "Acme" }),
        ],
      }),
    );
  });
});
