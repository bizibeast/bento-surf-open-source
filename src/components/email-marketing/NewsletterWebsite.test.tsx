import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { capturePublicEmailCapture } from "@/lib/commerce-growth.functions";
import { NewsletterWebsite } from "./NewsletterWebsite";

vi.mock("@/lib/commerce-growth.functions", () => ({
  capturePublicEmailCapture: vi.fn(),
}));

const publication = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Studio Notes",
  slug: "studio-notes",
  description: "A weekly studio letter",
  postal_address: "123 Studio Road",
  status: "published",
  accent_color: "#3478f6",
  paidProduct: { title: "Studio Notes Pro", public_slug: "studio-notes-pro" },
};

describe("NewsletterWebsite", () => {
  it("shows the selected publication's canonical archive and previews", () => {
    const onSettings = vi.fn();
    const onTemplates = vi.fn();
    const onToggleBento = vi.fn();
    const onEditPost = vi.fn();
    render(
      <NewsletterWebsite
        publication={publication}
        archiveData={{
          creator: { username: "ari-canonical", displayName: "Ari Kapoor" },
          publication: {
            title: publication.title,
            slug: publication.slug,
            description: publication.description,
            postalAddress: publication.postal_address,
          },
          paidProduct: { title: "Studio Notes Pro", publicSlug: "studio-notes-pro" },
          signupBlock: {
            id: "signup-1",
            type: "email_capture",
            content: {
              title: "Join Studio Notes",
              subtitle: "A weekly studio letter",
              buttonLabel: "Subscribe",
              tint: "sky",
              url: "/@ari-canonical/newsletters/studio-notes",
            },
            w: 2,
            h: 2,
          },
          issues: [
            {
              slug: "launch",
              subject: "Launch",
              previewText: "Public preview",
              visibility: "public",
            },
            {
              slug: "premium",
              subject: "Premium",
              previewText: "Paid preview",
              visibility: "paid",
            },
          ],
        }}
        posts={[
          {
            id: "post-1",
            name: "Launch",
            status: "published",
            public_slug: "launch",
            publication_id: publication.id,
            list_id: null,
            subject: "Launch",
            preview_text: "Public preview",
            web_visibility: "public",
            published_at: "2026-09-01T10:00:00.000Z",
            content: [{ id: "1", type: "paragraph", text: "Visible" }],
          },
          {
            id: "post-2",
            name: "Premium",
            status: "published",
            public_slug: "premium",
            publication_id: publication.id,
            list_id: null,
            subject: "Premium",
            preview_text: "Paid preview",
            web_visibility: "paid",
            published_at: "2026-09-02T10:00:00.000Z",
            content: [{ id: "1", type: "paragraph", text: "Paid" }],
          },
          {
            id: "post-3",
            name: "Not actually live",
            status: "published",
            public_slug: "missing-date",
            publication_id: publication.id,
            list_id: null,
            subject: "Missing date",
            preview_text: "Must match production filtering",
            web_visibility: "public",
            published_at: null,
            content: [{ id: "1", type: "paragraph", text: "Hidden" }],
          },
        ]}
        bentoAdded
        onToggleBento={onToggleBento}
        onSettings={onSettings}
        onTemplates={onTemplates}
        onEditPost={onEditPost}
        publicOrigin="https://bento.surf"
      />,
    );

    expect(screen.getByRole("link", { name: "Open publication page" })).toHaveAttribute(
      "href",
      "https://bento.surf/@ari-canonical/newsletters/studio-notes",
    );
    expect(screen.getByRole("link", { name: "View all publications" })).toHaveAttribute(
      "href",
      "https://bento.surf/@ari-canonical/newsletters",
    );
    expect(screen.getByRole("heading", { name: "Public pages" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Paid pages" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Subscribe to paid posts" })).toHaveAttribute(
      "href",
      "/@ari-canonical/products/studio-notes-pro",
    );
    expect(screen.getByLabelText("Desktop publication preview")).toHaveTextContent("Launch");
    expect(screen.getByLabelText("Desktop publication preview")).toHaveTextContent("Premium");
    expect(screen.getByLabelText("Desktop publication preview")).toHaveTextContent("Ari Kapoor");
    expect(screen.getByLabelText("Desktop publication preview")).toHaveTextContent(
      "Join Studio Notes",
    );
    expect(screen.queryByText("Not actually live")).not.toBeInTheDocument();
    const bentoSwitch = screen.getByRole("switch", { name: "Show publication on my Bento page" });
    expect(bentoSwitch).toHaveAttribute("aria-checked", "true");
    expect(bentoSwitch).toHaveClass("rounded-lg");
    expect(bentoSwitch).not.toHaveClass("rounded-full");
    fireEvent.click(screen.getByRole("switch", { name: "Show publication on my Bento page" }));
    expect(onToggleBento).toHaveBeenCalledWith(false);
    expect(screen.getByRole("link", { name: "View live page for Launch" })).toHaveAttribute(
      "href",
      "https://bento.surf/@ari-canonical/newsletters/studio-notes/launch",
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit Launch" }));
    expect(onEditPost).toHaveBeenCalledWith("post-1");
    fireEvent.click(screen.getByRole("button", { name: "Page details" }));
    fireEvent.click(screen.getByRole("button", { name: "SEO" }));
    expect(screen.queryByRole("button", { name: "Branding" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Default template" }));
    expect(onSettings.mock.calls).toEqual([["details"], ["seo"]]);
    expect(onTemplates).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Phone preview" }));
    expect(screen.getByLabelText("Phone publication preview")).toBeVisible();
    expect(screen.getByLabelText("Phone publication preview")).toHaveTextContent(
      "Subscribe to paid posts",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Email address" }), {
      target: { value: "preview@example.com" },
    });
    fireEvent.submit(screen.getByRole("textbox", { name: "Email address" }).closest("form")!);
    expect(screen.getByText("Preview only")).toBeVisible();
    expect(capturePublicEmailCapture).not.toHaveBeenCalled();
  });
});
