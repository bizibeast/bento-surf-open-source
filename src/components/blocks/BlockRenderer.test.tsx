import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlockRenderer, type Block } from "./BlockRenderer";

const capturePublicEmailCapture = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true, confirmationRequired: false }),
);

vi.mock("@/lib/commerce-growth.functions", () => ({ capturePublicEmailCapture }));

vi.mock("./PersistentMap", () => ({
  PersistentMap: ({ interactive }: { interactive: boolean }) => (
    <div data-testid="map-canvas" data-map-interactive={interactive ? "true" : "false"} />
  ),
}));

vi.mock("./LiveSocialBlock", () => ({
  LiveSocialGallery: () => <div data-testid="social-gallery" />,
  LiveSocialTile: () => <div data-testid="social-tile" />,
  LiveYouTubeVideo: ({ handle }: { handle?: string }) => (
    <div data-testid="youtube-latest-embed">{handle}</div>
  ),
}));

const mapBlock: Block = {
  id: "map-1",
  type: "map",
  content: {
    location: "Mumbai",
    title: "Mumbai, Maharashtra",
    mapLat: 19.076,
    mapLng: 72.8777,
    mapZoom: 11,
  },
  w: 4,
  h: 4,
};

const emailCaptureBlock: Block = {
  id: "00000000-0000-4000-8000-000000000001",
  type: "email_capture",
  content: {
    title: "Join my newsletter",
    subtitle: "Get new posts in your inbox.",
    buttonLabel: "Join",
    tint: "sky",
  },
  w: 2,
  h: 2,
};

const ALL_BLOCK_TYPES: Block["type"][] = [
  "social_link",
  "generic_link",
  "image",
  "image_gallery",
  "video",
  "spotify",
  "link_preview",
  "map",
  "heading",
  "note",
  "quote",
  "email_capture",
  "booking",
  "tip_jar",
  "contact",
  "audio",
  "file_download",
  "divider",
  "section_title",
  "experience",
  "commerce",
];

describe("editor and public block parity", () => {
  beforeEach(() => capturePublicEmailCapture.mockClear());

  it("stores a public email capture and announces success", async () => {
    const user = userEvent.setup();
    render(<BlockRenderer block={emailCaptureBlock} emailCaptureInteractive />);

    await user.type(screen.getByRole("textbox", { name: "Email address" }), "reader@example.com");
    await user.click(screen.getByRole("button", { name: "Join" }));

    expect(await screen.findByText("You're subscribed.")).toBeVisible();
    expect(capturePublicEmailCapture).toHaveBeenCalledWith({
      data: { blockId: emailCaptureBlock.id, email: "reader@example.com" },
    });
  });

  it("asks publication subscribers to confirm by email", async () => {
    capturePublicEmailCapture.mockResolvedValueOnce({ ok: true, confirmationRequired: true });
    const user = userEvent.setup();
    render(<BlockRenderer block={emailCaptureBlock} emailCaptureInteractive />);
    await user.type(screen.getByRole("textbox", { name: "Email address" }), "reader@example.com");
    await user.click(screen.getByRole("button", { name: "Join" }));
    expect(await screen.findByText("Check your email to confirm.")).toBeVisible();
  });

  it("does not expose database errors from public email capture", async () => {
    const user = userEvent.setup();
    capturePublicEmailCapture.mockRejectedValueOnce(
      new Error('relation "audience_contacts" does not exist'),
    );
    render(<BlockRenderer block={emailCaptureBlock} emailCaptureInteractive />);

    await user.type(screen.getByRole("textbox", { name: "Email address" }), "reader@example.com");
    await user.click(screen.getByRole("button", { name: "Join" }));

    expect(await screen.findByText("Could not subscribe. Please try again.")).toBeVisible();
    expect(screen.queryByText(/audience_contacts/)).not.toBeInTheDocument();
  });

  it("keeps preview email capture forms inert", async () => {
    const user = userEvent.setup();
    render(<BlockRenderer block={emailCaptureBlock} />);

    await user.click(screen.getByRole("button", { name: "Join" }));

    expect(screen.getByText("Preview only")).toBeVisible();
    expect(capturePublicEmailCapture).not.toHaveBeenCalled();
  });

  it("always shows the fixed email consent disclosure", () => {
    render(<BlockRenderer block={emailCaptureBlock} emailCaptureInteractive />);

    expect(
      screen.getByText("Receive emails from this creator. Unsubscribe anytime."),
    ).toBeVisible();
  });

  it("links each publication signup block to its canonical page", () => {
    render(
      <div>
        <BlockRenderer
          block={{
            ...emailCaptureBlock,
            id: "00000000-0000-4000-8000-000000000002",
            content: {
              ...emailCaptureBlock.content,
              title: "Studio Notes",
              url: "/@creator/newsletters/studio-notes",
            },
          }}
        />
        <BlockRenderer
          block={{
            ...emailCaptureBlock,
            id: "00000000-0000-4000-8000-000000000003",
            content: {
              ...emailCaptureBlock.content,
              title: "Product Notes",
              url: "/@creator/newsletters/product-notes",
            },
          }}
        />
      </div>,
    );

    expect(screen.getByRole("link", { name: "Studio Notes" })).toHaveAttribute(
      "href",
      "/@creator/newsletters/studio-notes",
    );
    expect(screen.getByRole("link", { name: "Product Notes" })).toHaveAttribute(
      "href",
      "/@creator/newsletters/product-notes",
    );
  });

  it.each(ALL_BLOCK_TYPES)("renders %s inside the canonical visual surface", (type) => {
    render(
      <BlockRenderer
        block={{
          id: `parity-${type}`,
          type,
          content: {},
          w: 2,
          h: 2,
        }}
      />,
    );

    expect(screen.getByTestId("block-render-surface")).toHaveAttribute("data-block-type", type);
    expect(screen.getByTestId("block-render-surface")).toHaveAttribute(
      "data-render-block-id",
      `parity-${type}`,
    );
    expect(screen.getByTestId("block-render-surface")).toHaveClass(
      "size-full",
      "overflow-hidden",
      "rounded-[28px]",
    );
  });

  it("can eagerly load an above-the-fold image block", () => {
    render(
      <BlockRenderer
        block={{
          id: "hero-image",
          type: "image",
          content: { url: "https://example.com/hero.png", loading: "eager" },
          w: 4,
          h: 2,
        }}
      />,
    );

    expect(screen.getByRole("presentation")).toHaveAttribute("loading", "eager");
  });

  it("renders a custom link icon without requiring anonymous CORS", () => {
    render(
      <BlockRenderer
        block={{
          id: "custom-link-icon",
          type: "generic_link",
          content: {
            url: "https://bento.surf",
            title: "bento.surf",
            customIcon: "https://bento.surf/cdn/users/example/custom-link-icon.png",
          },
          w: 2,
          h: 2,
        }}
      />,
    );

    const visibleIcon = screen
      .getByTestId("block-render-surface")
      .querySelector("img:not(.hidden)");

    expect(visibleIcon).toHaveAttribute(
      "src",
      "https://bento.surf/cdn/users/example/custom-link-icon.png",
    );
    expect(visibleIcon).not.toHaveAttribute("crossorigin");
  });

  it("shows the destination domain below the title when a custom link CTA is enabled", () => {
    render(
      <BlockRenderer
        block={{
          id: "custom-link-cta",
          type: "generic_link",
          content: {
            url: "https://www.product.example/launch",
            title: "Example Product",
            ctaEnabled: true,
            ctaLabel: "Visit",
          },
          w: 2,
          h: 2,
        }}
      />,
    );

    const title = screen.getByText("Example Product");
    const domain = screen.getByText("product.example");

    expect(title.compareDocumentPosition(domain)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.getByText("Visit")).toBeInTheDocument();
  });
});

describe("heading block levels", () => {
  it.each([
    ["h1", 1, "text-4xl"],
    ["h2", 2, "text-3xl"],
    ["h3", 3, "text-2xl"],
    ["h4", 4, "text-xl"],
    ["h5", 5, "text-lg"],
    ["h6", 6, "text-base"],
  ] as const)("renders %s as a semantic level-%s heading", (headingLevel, level, sizeClass) => {
    render(
      <BlockRenderer
        block={{
          id: `heading-${headingLevel}`,
          type: "heading",
          content: { text: "Currently building", headingLevel },
          w: 4,
          h: 1,
        }}
      />,
    );

    expect(screen.getByRole("heading", { level })).toHaveAttribute(
      "data-heading-level",
      headingLevel,
    );
    expect(screen.getByRole("heading", { level })).toHaveClass(sizeClass);
  });

  it("keeps existing text blocks at H2 when no level was saved", () => {
    render(
      <BlockRenderer
        block={{
          id: "heading-legacy",
          type: "heading",
          content: { text: "Existing heading" },
          w: 4,
          h: 1,
        }}
      />,
    );

    expect(screen.getByRole("heading", { level: 2 })).toHaveAttribute("data-heading-level", "h2");
  });

  it("applies a saved heading text color", () => {
    render(
      <BlockRenderer
        block={{
          id: "heading-color",
          type: "heading",
          content: { text: "Colorful heading", textColor: "#d2474b" },
          w: 4,
          h: 1,
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Colorful heading" })).toHaveStyle({
      color: "#d2474b",
    });
  });
});

describe("contact block appearance", () => {
  it("applies the saved email color and gradient material to the tile, icon, and CTA", () => {
    render(
      <BlockRenderer
        block={{
          id: "email-gradient",
          type: "contact",
          content: {
            kind: "email",
            value: "hello@bento.surf",
            label: "Email",
            color: "#e7702a",
            material: "gradient",
            ctaEnabled: true,
          },
          w: 2,
          h: 2,
        }}
      />,
    );

    const tile = screen.getByTestId("contact-tile");
    expect(tile).toHaveAttribute("data-material", "gradient");
    expect(tile.getAttribute("style")).toContain("linear-gradient");
    expect(tile.querySelector("div[style]")).toHaveStyle({ background: "#e7702a" });
    expect(tile.querySelector("span")).toHaveStyle({ background: "#e7702a" });
  });

  it("renders transparent material without falling back to the profile card background", () => {
    render(
      <BlockRenderer
        block={{
          id: "email-transparent",
          type: "contact",
          content: {
            kind: "email",
            value: "hello@bento.surf",
            material: "transparent",
          },
          w: 4,
          h: 1,
        }}
      />,
    );

    expect(screen.getByTestId("contact-tile")).toHaveAttribute("data-material", "transparent");
    expect(screen.getByTestId("contact-tile")).toHaveStyle({ background: "transparent" });
  });
});

describe("commerce block layouts", () => {
  const sizes = [
    [1, 1, "icon"],
    [4, 1, "strip"],
    [2, 2, "square"],
    [4, 2, "wide"],
    [2, 4, "tall"],
    [4, 4, "large"],
  ] as const;

  it.each(sizes)("uses the %s×%s %s layout", (w, h, layout) => {
    render(
      <BlockRenderer
        block={{
          id: `commerce-${w}-${h}`,
          type: "commerce",
          content: {
            productId: "product-1",
            kind: "digital_product",
            status: "published",
            slug: "creator-guide",
            title: "The Creator Guide",
            subtitle: "A practical plan for your next launch",
            pricingType: "one_time",
            priceAmount: 1900,
            currency: "usd",
            ctaLabel: "Get the guide",
          },
          w,
          h,
        }}
      />,
    );

    expect(screen.getByTestId("commerce-tile")).toHaveAttribute("data-layout", layout);
    expect(screen.getByTestId("commerce-tile")).toHaveAttribute("href", "/p/creator-guide");
    expect(screen.getByTestId("block-render-surface")).toHaveClass("overflow-hidden");
  });

  it("marks a draft product as hidden and links back to setup", () => {
    render(
      <BlockRenderer
        block={{
          id: "commerce-draft",
          type: "commerce",
          content: {
            productId: "product-draft",
            kind: "digital_product",
            status: "draft",
            title: "Draft guide",
            pricingType: "one_time",
            priceAmount: 1900,
            currency: "usd",
          },
          w: 2,
          h: 2,
        }}
      />,
    );

    expect(screen.getByText("Draft · hidden")).toBeInTheDocument();
    expect(screen.getByTestId("commerce-tile")).toHaveAttribute(
      "href",
      "/store?edit=product-draft",
    );
  });
});

describe("map block", () => {
  it("shows the location label in its normal presentation", () => {
    render(<BlockRenderer block={mapBlock} />);

    expect(screen.getByTestId("map-canvas")).toHaveAttribute("data-map-interactive", "false");
    expect(screen.queryByTitle("Map of Mumbai")).not.toBeInTheDocument();
    expect(screen.getByTestId("map-location-chip")).toHaveClass("w-fit", "text-xs", "px-3");
    expect(screen.getByTestId("map-location-pin")).toBeInTheDocument();
    expect(screen.getByText("Mumbai, Maharashtra")).toBeInTheDocument();
  });

  it("does not show a city-name fallback when the optional label is blank", () => {
    render(
      <BlockRenderer
        block={{
          ...mapBlock,
          content: { ...mapBlock.content, title: "" },
        }}
      />,
    );

    expect(screen.getByTestId("map-location-pin")).toBeInTheDocument();
    expect(screen.queryByTestId("map-location-chip")).not.toBeInTheDocument();
    expect(screen.queryByText("Mumbai")).not.toBeInTheDocument();
  });

  it("keeps the pin but hides the label while the map is being moved or zoomed", () => {
    render(<BlockRenderer block={mapBlock} mapInteractive />);

    expect(screen.getByTestId("map-canvas")).toHaveAttribute("data-map-interactive", "true");
    expect(screen.getByTestId("map-location-pin")).toBeInTheDocument();
    expect(screen.queryByText("Mumbai, Maharashtra")).not.toBeInTheDocument();
  });

  it("keeps legacy iframe maps out of keyboard navigation while dashboard editing is locked", () => {
    const legacyMap = {
      ...mapBlock,
      content: { location: "Mumbai", title: "Mumbai, Maharashtra" },
    };
    render(<BlockRenderer block={legacyMap} mapInteractive={false} />);

    expect(screen.getByTitle("Map of Mumbai")).toHaveAttribute("tabindex", "-1");
  });
});

describe("playable social embeds", () => {
  it("renders the live latest-video block for a YouTube channel", () => {
    render(
      <BlockRenderer
        liveSocialEnabled
        block={{
          id: "youtube-latest-1",
          type: "video",
          content: { liveProvider: "youtube", handle: "GoogleDevelopers" },
          w: 4,
          h: 2,
        }}
      />,
    );

    expect(screen.getByTestId("youtube-latest-embed")).toHaveTextContent("GoogleDevelopers");
  });

  it.each([
    [
      "instagram",
      "https://www.instagram.com/reel/ABC_def123/",
      "https://www.instagram.com/reel/ABC_def123/embed/",
    ],
    [
      "tiktok",
      "https://www.tiktok.com/@scout2015/video/6718335390845095173",
      "https://www.tiktok.com/player/v1/6718335390845095173?autoplay=0",
    ],
    [
      "twitter",
      "https://x.com/bento/status/1234567890123456789",
      "https://platform.twitter.com/embed/Tweet.html?id=1234567890123456789&dnt=true&theme=light",
    ],
  ] as const)("renders a normalized %s iframe", (provider, originalUrl, expectedSrc) => {
    render(
      <BlockRenderer
        block={{
          id: `${provider}-1`,
          type: "video",
          content: { embedProvider: provider, originalUrl, url: "https://example.com/untrusted" },
          w: 4,
          h: 2,
        }}
      />,
    );

    const frame = screen.getByTestId(`${provider}-embed`);
    expect(frame).toHaveAttribute("src", expectedSrc);
    expect(frame).toHaveAttribute("allowfullscreen");
    expect(frame).toHaveAttribute("loading", "lazy");
    expect(screen.getByTestId("block-render-surface")).toHaveClass(
      "overflow-hidden",
      "rounded-[28px]",
    );
  });

  it("shows a clean YouTube thumbnail with compact controls before loading the player", () => {
    render(
      <BlockRenderer
        block={{
          id: "youtube-1",
          type: "video",
          content: {
            embedProvider: "youtube",
            originalUrl: "https://youtu.be/M7lc1UVf-VE",
          },
          w: 4,
          h: 2,
        }}
      />,
    );

    const poster = screen.getByTestId("youtube-embed-poster");
    expect(poster).toHaveAccessibleName("Play YouTube video");
    expect(poster.querySelector("img")).toHaveClass("object-cover");
    expect(screen.queryByTestId("youtube-embed")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("youtube-embed-poster"));

    expect(screen.getByTestId("youtube-embed")).toHaveAttribute(
      "src",
      "https://www.youtube.com/embed/M7lc1UVf-VE?autoplay=1&playsinline=1&rel=0&modestbranding=1",
    );
  });

  it.each([
    [1, 1],
    [2, 2],
    [4, 4],
    [2, 4],
  ])("fits the full YouTube thumbnail in a %sx%s tile", (w, h) => {
    render(
      <BlockRenderer
        block={{
          id: `youtube-${w}x${h}`,
          type: "video",
          content: {
            embedProvider: "youtube",
            originalUrl: "https://youtu.be/M7lc1UVf-VE",
          },
          w,
          h,
        }}
      />,
    );

    expect(screen.getByTestId("youtube-embed-poster").querySelector("img")).toHaveClass(
      "object-contain",
    );
  });

  it("shows a YouTube text tag over the video in both poster and player states", () => {
    render(
      <BlockRenderer
        block={{
          id: "youtube-tag-1",
          type: "video",
          content: {
            embedProvider: "youtube",
            originalUrl: "https://youtu.be/M7lc1UVf-VE",
            title: "Watch my latest video",
          },
          w: 4,
          h: 2,
        }}
      />,
    );

    expect(screen.getByText("Watch my latest video")).toBeVisible();
    fireEvent.click(screen.getByTestId("youtube-embed-poster"));
    expect(screen.getByText("Watch my latest video")).toBeVisible();
    expect(screen.getByTestId("youtube-embed")).toBeInTheDocument();
  });

  it("shows the saved text tag over an uploaded video", () => {
    render(
      <BlockRenderer
        block={{
          id: "uploaded-video-tag-1",
          type: "video",
          content: {
            url: "https://cdn.example.com/launch.mp4",
            title: "Launch film",
          },
          w: 4,
          h: 3,
        }}
      />,
    );

    expect(screen.getByTestId("video-player")).toHaveAttribute(
      "src",
      "https://cdn.example.com/launch.mp4",
    );
    expect(screen.getByText("Launch film")).toBeVisible();
  });

  it("renders a legacy YouTube video URL as an embedded player with its thumbnail", () => {
    render(
      <BlockRenderer
        block={{
          id: "youtube-legacy-1",
          type: "video",
          content: { url: "https://www.youtube.com/embed/M7lc1UVf-VE" },
          w: 4,
          h: 2,
        }}
      />,
    );

    expect(screen.getByTestId("youtube-embed-poster")).toBeInTheDocument();
    expect(screen.queryByTestId("video-player")).not.toBeInTheDocument();
  });

  it("renders a Twitter post using its saved dark appearance", () => {
    render(
      <BlockRenderer
        block={{
          id: "twitter-dark-1",
          type: "video",
          content: {
            embedProvider: "twitter",
            originalUrl: "https://x.com/bento/status/1234567890123456789",
            twitterTheme: "dark",
          },
          w: 4,
          h: 2,
        }}
      />,
    );

    const frame = screen.getByTestId("twitter-embed");
    expect(frame).toHaveAttribute(
      "src",
      "https://platform.twitter.com/embed/Tweet.html?id=1234567890123456789&dnt=true&theme=dark",
    );
    expect(frame.parentElement).toHaveClass("bg-black");
  });

  it("renders legacy X tiles whose original URL was saved as Twitter's iframe URL", () => {
    render(
      <BlockRenderer
        block={{
          id: "twitter-legacy-1",
          type: "video",
          content: {
            embedProvider: "twitter",
            originalUrl:
              "https://platform.twitter.com/embed/Tweet.html?id=1234567890123456789&dnt=true&theme=light",
            twitterTheme: "dark",
          },
          w: 4,
          h: 2,
        }}
      />,
    );

    expect(screen.getByTestId("twitter-embed")).toHaveAttribute(
      "src",
      "https://platform.twitter.com/embed/Tweet.html?id=1234567890123456789&dnt=true&theme=dark",
    );
  });

  it("does not render a provider iframe when the stored source is invalid", () => {
    render(
      <BlockRenderer
        block={{
          id: "unsafe-1",
          type: "video",
          content: {
            embedProvider: "instagram",
            originalUrl: "https://example.com/reel/not-instagram",
            url: "https://example.com/untrusted",
          },
          w: 2,
          h: 3,
        }}
      />,
    );

    expect(screen.queryByTestId("instagram-embed")).not.toBeInTheDocument();
    expect(screen.getByText("Add a video URL")).toBeInTheDocument();
  });
});
