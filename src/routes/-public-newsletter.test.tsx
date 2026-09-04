import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { getRouter } from "@/router";
import {
  PublicNewsletterArchiveContent,
  PublicNewsletterDirectoryContent,
} from "@/components/email-marketing/PublicNewsletterArchive";
import archiveRoute from "./$username_.newsletter.tsx?raw";
import issueRoute from "./$username_.newsletter_.$issueSlug.tsx?raw";
import publicationRoute from "./$username_.newsletters.$publicationSlug.tsx?raw";
import {
  publicNewsletterArchiveFromRows,
  publicNewsletterIssueFromRows,
} from "@/lib/newsletter.functions";
import {
  publicNewsletterArchiveHead,
  publicNewsletterDirectoryHead,
  publicNewsletterIssueHead,
} from "@/lib/open-graph";

vi.mock("@/components/patterns/PatternBackdrop", () => ({ PatternBackdrop: () => null }));

const creator = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "ari",
  display_name: "Ari",
  avatar_url: null,
  accent_color: "#3478f6",
  theme: "dark",
  primary_font: "Inter",
  secondary_font: "Instrument Serif",
  pattern: "dots",
  pattern_settings: { intensity: 40 },
};
const publication = {
  id: "22222222-2222-4222-8222-222222222222",
  creator_id: creator.id,
  title: "Studio Notes",
  slug: "studio-notes",
  description: "Notes from the studio",
  logo_url: null,
  cover_url: null,
  accent_color: "#3478f6",
  postal_address: "Bengaluru, India",
  paid_product_id: "33333333-3333-4333-8333-333333333333",
  status: "published",
};
const issues = [
  {
    name: "The original launch post",
    subject: "Launch day",
    preview_text: "We are live",
    public_slug: "launch-day",
    web_visibility: "public",
    status: "published",
    template_id: "bold-digest",
    published_at: "2026-08-31T00:00:00.000Z",
    content: [{ id: "1", type: "heading", text: "Launch day" }],
  },
  {
    subject: "Members only",
    preview_text: "A paid preview",
    public_slug: "members-only",
    web_visibility: "paid",
    status: "published",
    published_at: "2026-08-30T00:00:00.000Z",
    content: [{ id: "2", type: "paragraph", text: "Secret body" }],
  },
  {
    subject: "Draft",
    preview_text: "Hidden",
    public_slug: "draft",
    web_visibility: "public",
    status: "draft",
    published_at: null,
    content: [{ id: "3", type: "paragraph", text: "Draft body" }],
  },
  {
    subject: "Private",
    preview_text: "Hidden",
    public_slug: null,
    web_visibility: "private",
    status: "published",
    published_at: "2026-08-29T00:00:00.000Z",
    content: [{ id: "4", type: "paragraph", text: "Private body" }],
  },
];
const paidProduct = {
  id: publication.paid_product_id,
  creator_id: creator.id,
  public_slug: "studio-notes",
  title: "Studio Notes membership",
  kind: "newsletter",
  status: "published",
};

describe("public newsletter routes", () => {
  it("shows only published public/paid issues and never leaks paid content", () => {
    const archive = publicNewsletterArchiveFromRows({
      canonicalUsername: "ari",
      creator,
      publication,
      issues,
      paidProduct,
    });
    expect(archive?.issues.map((issue) => issue.slug)).toEqual(["launch-day", "members-only"]);
    expect(archive).not.toHaveProperty("publication.reply_to_email");
    expect(JSON.stringify(archive)).not.toContain("Secret body");

    const paid = publicNewsletterIssueFromRows({
      canonicalUsername: "ari",
      creator,
      publication,
      issues,
      issueSlug: "members-only",
      paidProduct,
    });
    expect(paid).toMatchObject({ issue: { visibility: "paid", content: null } });
    expect(paid?.paidProduct?.publicSlug).toBe("studio-notes");
    expect(archive?.issues[0]).toMatchObject({ templateId: "bold-digest" });
    expect(archive?.issues[0].subject).toBe("The original launch post");
    expect(archive?.creator).toMatchObject({
      theme: "dark",
      primaryFont: "Inter",
      secondaryFont: "Instrument Serif",
      pattern: "dots",
    });
  });

  it("rejects unowned, draft, private, unsafe, and unlinked paid issues", () => {
    expect(
      publicNewsletterArchiveFromRows({
        canonicalUsername: "ari",
        creator,
        publication: { ...publication, creator_id: "99999999-9999-4999-8999-999999999999" },
        issues,
        paidProduct,
      }),
    ).toBeNull();
    expect(
      publicNewsletterIssueFromRows({
        canonicalUsername: "ari",
        creator,
        publication,
        issues,
        issueSlug: "draft",
        paidProduct,
      }),
    ).toBeNull();
    expect(
      publicNewsletterIssueFromRows({
        canonicalUsername: "ari",
        creator,
        publication,
        issues: [
          {
            ...issues[0],
            content: [{ id: "unsafe", type: "button", label: "Bad", url: "javascript:alert(1)" }],
          },
        ],
        issueSlug: "launch-day",
        paidProduct,
      }),
    ).toBeNull();
    expect(
      publicNewsletterIssueFromRows({
        canonicalUsername: "ari",
        creator,
        publication,
        issues,
        issueSlug: "members-only",
        paidProduct: null,
      }),
    ).toBeNull();
  });

  it("resolves published creator products without leaking product IDs", () => {
    const result = publicNewsletterIssueFromRows({
      canonicalUsername: "ari",
      creator,
      publication,
      issues: [
        {
          ...issues[0],
          content: [
            { id: "private", type: "image", url: "https://127.0.0.1/internal", alt: "Private" },
            {
              id: "product",
              type: "product",
              productId: "44444444-4444-4444-8444-444444444444",
            },
            { id: "safe", type: "paragraph", text: "Public text" },
          ],
        },
      ],
      issueSlug: "launch-day",
      paidProduct,
      products: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          creator_id: creator.id,
          status: "published",
          title: "Creator Kit",
          description: "Templates for creators",
          public_slug: "creator-kit",
          price_amount: 1900,
          currency: "usd",
          billing_interval: null,
        },
      ],
    });
    expect(result?.issue.content).toEqual([
      {
        id: "product",
        type: "product",
        product: {
          title: "Creator Kit",
          description: "Templates for creators",
          url: "/@ari/products/creator-kit",
          priceAmount: 1900,
          currency: "usd",
          billingInterval: null,
        },
      },
      { id: "safe", type: "paragraph", text: "Public text" },
    ]);
    expect(JSON.stringify(result)).not.toContain("44444444-4444-4444-8444-444444444444");
  });

  it("redirects aliases to canonical archive and issue URLs", () => {
    expect(archiveRoute).toContain("publicNewsletterPath(data.creator.username)");
    expect(issueRoute).toContain(
      "publicNewsletterIssuePath(data.creator.username, data.issue.slug)",
    );
    expect(archiveRoute).toContain("statusCode: 307");
    expect(issueRoute).toContain("statusCode: 307");
  });

  it("registers the canonical publication archive route", () => {
    expect(publicationRoute).toContain(
      'createFileRoute("/$username_/newsletters/$publicationSlug")',
    );
  });

  it("lists every published publication on the themed creator directory", () => {
    render(
      <PublicNewsletterDirectoryContent
        data={{
          creator: {
            username: "ari",
            displayName: "Ari",
            theme: "dark",
            accentColor: "#3478f6",
          },
          publications: [
            { title: "Studio Notes", slug: "studio-notes", description: "Studio dispatches" },
            { title: "Product Notes", slug: "product-notes", description: "Product updates" },
          ],
        }}
      />,
    );

    expect(screen.getByRole("region", { name: "Publications" })).toBeVisible();
    expect(screen.getByRole("link", { name: /Studio Notes/ })).toHaveAttribute(
      "href",
      "/@ari/newsletters/studio-notes",
    );
    expect(screen.getByRole("link", { name: /Product Notes/ })).toHaveAttribute(
      "href",
      "/@ari/newsletters/product-notes",
    );
    expect(document.querySelector("[data-bento-public-page]")).toHaveAttribute(
      "data-theme",
      "dark",
    );
  });

  it.each([
    ["/@ari/newsletters", "/$username/newsletters/"],
    ["/@ari/newsletter/launch-day", "/$username/newsletter/$issueSlug"],
    [
      "/@ari/newsletters/studio-notes/launch-day",
      "/$username/newsletters/$publicationSlug/$postSlug",
    ],
  ])("matches %s without the archive head", (path, expectedFullPath) => {
    const router = getRouter();
    const matches = router.matchRoutes(path);
    const leaf = router.routesById[matches.at(-1)!.routeId];
    const pageHeadMatches = matches.filter(
      (match) => match.routeId !== "__root__" && router.routesById[match.routeId].options.head,
    );

    expect(leaf.fullPath).toBe(expectedFullPath);
    expect(pageHeadMatches.map((match) => match.routeId)).toEqual([leaf.id]);
  });

  it("links paid newsletter CTAs to the canonical commerce checkout page", () => {
    render(
      <PublicNewsletterArchiveContent
        emailCaptureInteractive
        data={{
          creator: {
            username: "ari",
            displayName: "Ari",
            theme: "dark",
            accentColor: "#3478f6",
            primaryFont: "Inter",
            secondaryFont: "Instrument Serif",
            pattern: "dots",
            patternSettings: { intensity: 40 },
          },
          publication: {
            title: "Studio Notes",
            slug: "studio-notes",
            description: "Notes from the studio",
            postalAddress: "Bengaluru, India",
          },
          paidProduct: { title: "Studio Notes membership", publicSlug: "studio-notes" },
          issues: [],
        }}
      />,
    );
    expect(screen.getByRole("link", { name: "Subscribe to paid posts" })).toHaveAttribute(
      "href",
      "/@ari/products/studio-notes",
    );
    expect(document.querySelector("[data-bento-public-page]")).toHaveAttribute(
      "data-theme",
      "dark",
    );
    expect(screen.getByText("No public posts yet.")).toBeVisible();
    expect(issueRoute).toContain(
      "publicProductPath(data.creator.username, data.paidProduct.publicSlug)",
    );
  });

  it("emits canonical sanitized social metadata and noindexes paid teasers", () => {
    const directoryHead = publicNewsletterDirectoryHead(
      {
        creator: { username: "ari", displayName: "Ari" },
        publications: [{ title: "Studio Notes" }, { title: "Product Notes" }],
      },
      "https://bento.surf",
    );
    expect(directoryHead.links).toContainEqual({
      rel: "canonical",
      href: "https://bento.surf/@ari/newsletters",
    });
    const archiveHead = publicNewsletterArchiveHead(
      {
        creator: { username: "ari", displayName: '<script>alert("x")</script>' },
        publication: {
          title: "Studio Notes",
          slug: "studio-notes",
          description: "Notes <b>weekly</b>",
        },
      },
      "https://bento.surf",
    );
    expect(archiveHead.links).toContainEqual({
      rel: "canonical",
      href: "https://bento.surf/@ari/newsletters/studio-notes",
    });
    expect(archiveHead.meta).toContainEqual({
      property: "og:url",
      content: "https://bento.surf/@ari/newsletters/studio-notes",
    });
    expect(JSON.stringify(archiveHead)).not.toContain("<script>");

    const issueHead = publicNewsletterIssueHead(
      {
        creator: { username: "ari", displayName: "Ari" },
        publication: { title: "Studio Notes", slug: "studio-notes" },
        issue: {
          slug: "members-only",
          subject: "Members only",
          previewText: "A paid preview",
          visibility: "paid",
        },
      },
      "https://bento.surf",
    );
    expect(issueHead.links).toContainEqual({
      rel: "canonical",
      href: "https://bento.surf/@ari/newsletters/studio-notes/members-only",
    });
    expect(issueHead.meta).toContainEqual({
      name: "robots",
      content: "noindex, nofollow, noarchive",
    });
  });
});
