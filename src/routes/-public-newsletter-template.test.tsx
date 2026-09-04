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
});
