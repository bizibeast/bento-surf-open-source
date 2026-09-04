import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CATEGORIES, findPlatform } from "@/lib/platforms";
import { AddBlockPicker } from "./AddBlockPicker";

vi.mock("@/lib/profile.functions", () => ({
  getMyProfile: vi.fn().mockResolvedValue({ is_pro: true }),
}));

vi.mock("@/lib/upload", () => ({
  uploadFile: vi.fn().mockResolvedValue("https://cdn.example.com/acme-logo.png"),
}));

vi.mock("@/lib/link-metadata.functions", () => ({
  fetchLinkMetadata: vi.fn().mockResolvedValue({
    url: "https://product.example/",
    title: "Example Product",
    favicon: "https://product.example/favicon.svg",
    color: "#007cff",
  }),
}));

describe("AddBlockPicker", () => {
  it("keeps every block category in the vertical category rail", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AddBlockPicker open onOpenChange={() => undefined} onAdd={() => undefined} />
      </QueryClientProvider>,
    );

    const categoryRail = screen.getByRole("navigation", { name: "Block categories" });
    expect(categoryRail).toBeInTheDocument();
    for (const category of CATEGORIES) {
      expect(
        within(categoryRail).getByRole("button", { name: category.label }),
      ).toBeInTheDocument();
    }
    expect(within(categoryRail).getByRole("button", { name: "Custom" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Image" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Video" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Audio" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Quote" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Location" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Heading / Text" })).toBeInTheDocument();
  });

  it("keeps the YouTube channel in Social while video widgets stay in Video", () => {
    expect(findPlatform("youtube")?.category).toBe("social");
    expect(findPlatform("youtube_embed")?.category).toBe("video");
    expect(findPlatform("youtube_embed")?.defaults).toEqual({ embedProvider: "youtube" });
    expect(findPlatform("youtube_recent")?.category).toBe("video");
  });

  it("offers Priority DM in Sell & Grow", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AddBlockPicker open onOpenChange={() => undefined} onAdd={() => undefined} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sell & Grow" }));
    expect(screen.getByRole("button", { name: /^Priority DM/ })).toBeInTheDocument();
    expect(findPlatform("priority_dm")?.defaults).toEqual({ productKind: "priority_dm" });
  });

  it("offers newsletter signup in Sell & Grow with capture defaults", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AddBlockPicker open onOpenChange={() => undefined} onAdd={() => undefined} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sell & Grow" }));
    expect(screen.getByRole("button", { name: /^Newsletter signup/ })).toBeInTheDocument();
    expect(findPlatform("email_capture")).toMatchObject({
      category: "monetize",
      blockType: "email_capture",
      defaults: {
        title: "Join my newsletter",
        subtitle: "Get new posts in your inbox.",
        buttonLabel: "Join",
        tint: "sky",
      },
    });
  });

  it.each([
    ["Image", "Upload image"],
    ["Video", "Upload video"],
    ["Audio", "Upload audio"],
  ])("opens %s as its own upload block", (blockName, uploadLabel) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AddBlockPicker open onOpenChange={() => undefined} onAdd={() => undefined} />
      </QueryClientProvider>,
    );

    const blockButtons = screen.getAllByRole("button", { name: blockName });
    fireEvent.click(blockButtons[blockButtons.length - 1]);
    expect(screen.getByText(uploadLabel)).toBeInTheDocument();
    expect(screen.queryByText("Media type")).not.toBeInTheDocument();
  });

  it("opens the media-bar video composer with upload, URL, and text-tag options", () => {
    const onAdd = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AddBlockPicker
          open
          initialPlatformKey="custom_video"
          onOpenChange={() => undefined}
          onAdd={onAdd}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Upload video")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Video URL" }), {
      target: { value: "https://cdn.example.com/launch.mp4" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Text tag (optional)" }), {
      target: { value: "Launch film" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "video",
        content: {
          url: "https://cdn.example.com/launch.mp4",
          title: "Launch film",
        },
      }),
    );
  });

  it("captures and persists a custom link's website color", async () => {
    const onAdd = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AddBlockPicker open onOpenChange={() => undefined} onAdd={onAdd} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Custom link" }));
    fireEvent.change(screen.getByRole("textbox", { name: "URL" }), {
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

  it("opens the quote and location composers from the full picker", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = render(
      <QueryClientProvider client={queryClient}>
        <AddBlockPicker open onOpenChange={() => undefined} onAdd={() => undefined} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Quote" }));
    expect(screen.getByRole("textbox", { name: "Quote" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Author (optional)" })).toBeInTheDocument();
    unmount();

    const secondQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={secondQueryClient}>
        <AddBlockPicker open onOpenChange={() => undefined} onAdd={() => undefined} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Location" }));
    expect(screen.getByRole("textbox", { name: "Location" })).toBeInTheDocument();
  });

  it("keeps a map label empty unless the creator enters one", () => {
    const onAdd = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AddBlockPicker open onOpenChange={() => undefined} onAdd={onAdd} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Location" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Location" }), {
      target: { value: "Mumbai" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "map",
        content: {
          location: "Mumbai",
          title: "",
        },
      }),
    );
  });

  it("creates X posts as light 2x4 horizontal blocks by default", () => {
    const onAdd = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AddBlockPicker open onOpenChange={() => undefined} onAdd={onAdd} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Social" }));
    fireEvent.click(screen.getByRole("button", { name: "X post / Tweet" }));
    fireEvent.change(screen.getByPlaceholderText("https://x.com/creator/status/..."), {
      target: { value: "https://x.com/bento/status/1234567890123456789" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "video",
        w: 4,
        h: 2,
        content: expect.objectContaining({
          embedProvider: "twitter",
          twitterTheme: "light",
        }),
      }),
    );
  });

  it("uploads an Experience logo and preserves the chosen display order", async () => {
    const onAdd = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AddBlockPicker open onOpenChange={() => undefined} onAdd={onAdd} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Experience" }));
    fireEvent.change(screen.getByPlaceholderText("Company name"), {
      target: { value: "Acme" },
    });

    const logoInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(logoInput).not.toBeNull();
    fireEvent.change(logoInput!, {
      target: { files: [new File(["logo"], "acme.png", { type: "image/png" })] },
    });
    await waitFor(() =>
      expect(screen.getByAltText("")).toHaveAttribute(
        "src",
        expect.stringContaining("acme-logo.png"),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Add another company" }));
    const companyInputs = screen.getAllByPlaceholderText("Company name");
    fireEvent.change(companyInputs[1], { target: { value: "Beta" } });
    fireEvent.click(screen.getByRole("button", { name: "Move role 2 up" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "experience",
        content: {
          items: [
            expect.objectContaining({ company: "Beta", logo: "" }),
            expect.objectContaining({
              company: "Acme",
              logo: "https://cdn.example.com/acme-logo.png",
            }),
          ],
        },
      }),
    );
  });
});
