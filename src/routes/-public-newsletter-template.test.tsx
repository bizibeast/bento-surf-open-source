import { render, screen } from "@testing-library/react";
import { vi, describe, expect, it } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({ useLoaderData: vi.fn() }),
  Link: ({ children }: { children: React.ReactNode }) => <a href="#preview">{children}</a>,
  notFound: vi.fn(),
  redirect: vi.fn(),
}));

import { PublicNewsletterPostView } from "./$username_.newsletter_.$issueSlug";

describe("public newsletter template", () => {
  it("renders the persisted post presentation", () => {
    render(
      <PublicNewsletterPostView
        data={
          {
            creator: { username: "ari" },
            publication: {
              title: "Studio Notes",
              slug: "studio-notes",
              postalAddress: "Bengaluru, India",
            },
            issue: {
              subject: "Launch day",
              previewText: "We are live",
              visibility: "public",
              templateId: "bold-digest",
              content: [{ id: "body", type: "paragraph", text: "Launch body" }],
            },
            paidProduct: null,
          } as never
        }
      />,
    );

    expect(screen.getByRole("article")).toHaveStyle({ backgroundColor: "#fff6f5" });
  });

  it("renders the production unavailable state when a paid offer is missing", () => {
    render(
      <PublicNewsletterPostView
        data={
          {
            creator: { username: "ari" },
            publication: {
              title: "Studio Notes",
              slug: "studio-notes",
              postalAddress: "Bengaluru, India",
            },
            issue: {
              subject: "Members only",
              previewText: "A paid preview",
              visibility: "paid",
              templateId: null,
              content: null,
            },
            paidProduct: null,
          } as never
        }
      />,
    );

    expect(screen.getByRole("article")).toHaveTextContent("Paid post unavailable");
    expect(screen.queryByRole("link", { name: /Subscribe to/ })).toBeNull();
  });

  it("keeps creator identity and navigation around a published post", () => {
    render(
      <PublicNewsletterPostView
        data={
          {
            chrome: {
              creator: {
                id: "11111111-1111-4111-8111-111111111111",
                username: "ari",
                display_name: "Ari",
                bio: "Helping creators publish",
                avatar_url: null,
                cover_url: null,
                theme: "light",
                accent_color: "indigo",
                primary_font: null,
                secondary_font: null,
                header_mode: "with_photo",
                is_pro: false,
                badge_hidden: false,
              },
              pages: [
                {
                  id: "newsletter-page",
                  name: "Newsletters",
                  slug: "newsletters",
                  href: "/@ari/newsletters",
                  url: null,
                  system: "newsletter",
                },
              ],
              customDomain: null,
            },
            activePageId: "newsletter-page",
            creator: { username: "ari" },
            publication: {
              title: "Studio Notes",
              slug: "studio-notes",
              postalAddress: "Bengaluru, India",
            },
            issue: {
              subject: "Launch day",
              previewText: "We are live",
              visibility: "public",
              templateId: "bold-digest",
              content: [{ id: "body", type: "paragraph", text: "Launch body" }],
            },
            paidProduct: null,
          } as never
        }
      />,
    );

    expect(document.querySelector("aside > p")).toHaveTextContent("Ari");
    expect(screen.getByText("Helping creators publish")).toBeVisible();
    expect(screen.getByRole("link", { name: "Newsletters" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByText("Launch body")).toBeVisible();
  });
});
