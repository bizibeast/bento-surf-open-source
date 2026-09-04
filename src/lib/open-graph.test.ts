import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPEN_GRAPH_IMAGE_PATH,
  publicPageCanonicalUrl,
  publicPageHead,
  publicPageOpenGraphImageUrl,
  publicPagePreviewVersion,
  publicProductHead,
  type PublicPagePreviewData,
} from "./open-graph";

function previewData(): PublicPagePreviewData {
  return {
    profile: {
      id: "profile-1",
      username: "creator",
      display_name: "Creator Name",
      bio: "A visual creator page",
      updated_at: "2026-07-20T10:00:00.000Z",
    },
    pages: [{ id: "page-1", name: "Links", slug: "links", updated_at: "2026-07-20T10:00:00.000Z" }],
    blocks: [
      { id: "block-1", updated_at: "2026-07-20T10:00:00.000Z" },
      { id: "block-2", updated_at: "2026-07-20T10:00:00.000Z" },
    ],
    activePageId: "page-1",
  };
}

describe("public page Open Graph metadata", () => {
  it("uses the bundled generic preview asset", () => {
    expect(DEFAULT_OPEN_GRAPH_IMAGE_PATH).toBe("/branding/bento-logo.png");
  });

  it("builds a canonical, versioned large-image preview", () => {
    const data = previewData();
    const version = publicPagePreviewVersion(data);
    const image = publicPageOpenGraphImageUrl(data, "https://bento.surf/");
    const head = publicPageHead(data, "https://bento.surf/");

    expect(publicPageCanonicalUrl(data, "https://bento.surf/")).toBe(
      "https://bento.surf/@creator/links",
    );
    expect(image).toBe(`https://bento.surf/api/og/creator/links.jpg?v=${version}`);
    expect(head.meta).toContainEqual({ name: "twitter:card", content: "summary_large_image" });
    expect(head.meta).toContainEqual({ property: "og:image", content: image });
    expect(head.meta).toContainEqual({ property: "og:image:width", content: "2400" });
    expect(head.meta).toContainEqual({ property: "og:image:height", content: "1260" });
    expect(JSON.parse(head.scripts[0].children)).toMatchObject({
      "@type": "WebPage",
      url: "https://bento.surf/@creator/links",
      isPartOf: {
        "@type": "ProfilePage",
        "@id": "https://bento.surf/@creator#profile",
      },
      about: {
        "@type": "Person",
        "@id": "https://bento.surf/@creator#creator",
        alternateName: "@creator",
        url: "https://bento.surf/@creator",
      },
    });
  });

  it("uses one stable ProfilePage entity for the creator home", () => {
    const data = previewData();
    data.activePageId = null;
    const schema = JSON.parse(publicPageHead(data, "https://public.example").scripts[0].children);

    expect(schema).toMatchObject({
      "@type": "ProfilePage",
      "@id": "https://public.example/@creator#profile",
      url: "https://public.example/@creator",
      mainEntity: {
        "@type": "Person",
        "@id": "https://public.example/@creator#creator",
      },
    });
  });

  it("keeps system-page canonicals and metadata distinct", () => {
    const data = previewData();
    data.activePageId = null;
    data.activePageSlug = "insights";
    data.activePageName = "Social media insights";
    const head = publicPageHead(data, "https://public.example");

    expect(head.links).toContainEqual({
      rel: "canonical",
      href: "https://public.example/@creator/insights",
    });
    expect(head.meta).toContainEqual({
      title: "Social Media Insights for Creator Name | bento.surf",
    });
    expect(JSON.parse(head.scripts[0].children)).toMatchObject({
      "@type": "WebPage",
      url: "https://public.example/@creator/insights",
      isPartOf: { "@id": "https://public.example/@creator#profile" },
    });
  });

  it("preloads the profile image used above the fold", () => {
    const data = previewData();
    data.profile.avatar_url = "https://cdn.bento.surf/avatar.webp";

    expect(publicPageHead(data).links).toContainEqual({
      rel: "preload",
      as: "image",
      href: "https://cdn.bento.surf/avatar.webp",
    });
  });

  it("changes the image version for profile, page, block, layout, and deletion changes", () => {
    const original = previewData();
    const version = publicPagePreviewVersion(original);

    const changedProfile = previewData();
    changedProfile.profile.updated_at = "2026-07-20T10:01:00.000Z";
    expect(publicPagePreviewVersion(changedProfile)).not.toBe(version);

    const changedPage = previewData();
    changedPage.pages[0].updated_at = "2026-07-20T10:02:00.000Z";
    expect(publicPagePreviewVersion(changedPage)).not.toBe(version);

    const changedBlock = previewData();
    changedBlock.blocks[0].updated_at = "2026-07-20T10:03:00.000Z";
    expect(publicPagePreviewVersion(changedBlock)).not.toBe(version);

    const changedLayout = previewData();
    changedLayout.activePageId = null;
    expect(publicPagePreviewVersion(changedLayout)).not.toBe(version);

    const deletedBlock = previewData();
    deletedBlock.blocks.pop();
    expect(publicPagePreviewVersion(deletedBlock)).not.toBe(version);
  });

  it("keeps hidden and unfinished creator pages out of search results", () => {
    const hidden = previewData();
    hidden.profile.noindex = true;
    expect(publicPageHead(hidden).meta).toContainEqual({
      name: "robots",
      content: "noindex, nofollow, noarchive",
    });

    const unfinished = previewData();
    unfinished.profile.onboarded = false;
    expect(publicPageHead(unfinished).meta).toContainEqual({
      name: "robots",
      content: "noindex, nofollow, noarchive",
    });
  });
});

describe("public product Open Graph metadata", () => {
  it("uses the product and creator in share metadata", () => {
    const head = publicProductHead(
      {
        product: {
          slug: "creator-course",
          public_slug: "creator-course",
          title: "Creator Course",
          subtitle: "Build a thoughtful creator business.",
          description: "A longer description.",
          cover_url: "https://cdn.bento.surf/course.jpg",
          pricing_type: "one_time",
          price_amount: 4900,
          currency: "usd",
          billing_interval: null,
          inventory_limit: 10,
          sales_count: 3,
          published_at: "2026-08-20T10:00:00.000Z",
        },
        creator: {
          username: "creator",
          display_name: "Creator Name",
        },
      },
      "https://bento.surf/",
    );

    expect(head.meta).toContainEqual({
      title: "Creator Course by Creator Name | bento.surf",
    });
    expect(head.meta).toContainEqual({
      property: "og:url",
      content: "https://bento.surf/@creator/products/creator-course",
    });
    expect(head.meta).toContainEqual({
      property: "og:image",
      content: "https://cdn.bento.surf/course.jpg",
    });
    expect(head.meta).toContainEqual({
      name: "twitter:card",
      content: "summary_large_image",
    });
    expect(JSON.parse(head.scripts[0].children)).toMatchObject({
      "@type": "Product",
      name: "Creator Course",
      image: "https://cdn.bento.surf/course.jpg",
      offers: {
        "@type": "Offer",
        price: "49.00",
        priceCurrency: "USD",
        availability: "https://schema.org/InStock",
        seller: {
          "@type": "Person",
          url: "https://bento.surf/@creator",
        },
      },
    });
  });

  it("falls back safely when the product has no cover or summary", () => {
    const head = publicProductHead({
      product: {
        slug: "coaching-call",
        public_slug: "coaching-call",
        title: "Coaching Call",
        subtitle: null,
        description: null,
        cover_url: null,
      },
      creator: {
        username: "coach",
        display_name: null,
      },
    });

    expect(head.meta).toContainEqual({
      name: "description",
      content: "Buy Coaching Call from coach on bento.surf.",
    });
    expect(head.meta).toContainEqual({ name: "twitter:card", content: "summary" });
    expect(head.meta.some((entry) => "property" in entry && entry.property === "og:image")).toBe(
      false,
    );
    expect(head.scripts).toEqual([]);
  });

  it("inherits creator search visibility", () => {
    const head = publicProductHead({
      product: {
        slug: "hidden-product",
        public_slug: "hidden-product",
        title: "Hidden Product",
        subtitle: null,
        description: null,
        cover_url: null,
      },
      creator: { username: "creator", display_name: null, noindex: true },
    });

    expect(head.meta).toContainEqual({
      name: "robots",
      content: "noindex, nofollow, noarchive",
    });
  });

  it("keeps a hidden product out of search results", () => {
    const head = publicProductHead({
      product: {
        slug: "private-draft",
        public_slug: "private-draft",
        title: "Private Draft",
        subtitle: null,
        description: null,
        cover_url: null,
        noindex: true,
      },
      creator: { username: "creator", display_name: null, noindex: false },
    });

    expect(head.meta).toContainEqual({
      name: "robots",
      content: "noindex, nofollow, noarchive",
    });
  });
});
