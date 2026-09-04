import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NewsletterDocument } from "@/components/email-marketing/NewsletterDocument";
import { renderNewsletterEmailDocument } from "./email-templates";
import { newsletterContentSchema } from "./newsletter";
import {
  NEWSLETTER_TEMPLATE_IDS,
  NEWSLETTER_TEMPLATES,
  createTemplatePostContent,
  getNewsletterTemplate,
  uniqueTemplatePostIdentity,
} from "./newsletter-templates";

const templateIds = NEWSLETTER_TEMPLATE_IDS;

describe("newsletter templates", () => {
  it("offers 28 named templates with unique names and one default", () => {
    expect(NEWSLETTER_TEMPLATES.map((template) => template.id)).toEqual(templateIds);
    expect(new Set(NEWSLETTER_TEMPLATES.map((template) => template.name)).size).toBe(28);
    expect(NEWSLETTER_TEMPLATES.filter((template) => template.isDefault)).toHaveLength(1);
  });

  it("uses materially different structures instead of color variants", () => {
    const signatures = NEWSLETTER_TEMPLATES.map((template) =>
      template.content
        .map((block) =>
          block.type === "section"
            ? `${block.type}:${block.layout}:${block.columns
                .map((column) => column.map((child) => child.type).join(","))
                .join("|")}`
            : block.type,
        )
        .join("/"),
    );

    expect(new Set(signatures).size).toBeGreaterThanOrEqual(16);
  });

  it.each(templateIds)("creates valid independent %s starter content", (templateId) => {
    const first = createTemplatePostContent(templateId);
    const second = createTemplatePostContent(templateId);
    expect(newsletterContentSchema.safeParse(first).success).toBe(true);
    expect(first.length).toBeGreaterThanOrEqual(9);
    expect(first.some((block) => block.type === "image")).toBe(true);
    expect(first.map((block) => block.id)).not.toEqual(second.map((block) => block.id));
  });

  it("does not generate image blocks that point to removed marketing assets", () => {
    const imageUrls = templateIds.flatMap((templateId) =>
      createTemplatePostContent(templateId).flatMap((block) =>
        block.type === "image"
          ? [block.url]
          : block.type === "section"
            ? block.columns.flat().flatMap((child) => (child.type === "image" ? [child.url] : []))
            : [],
      ),
    );

    expect(
      imageUrls.filter(
        (url) =>
          url.startsWith("/marketing/") ||
          url === "/branding/landing-og.jpg" ||
          url === "/branding/bento-preview.png",
      ),
    ).toEqual([]);
  });

  it.each(templateIds)("renders %s through email and web renderers", (templateId) => {
    const template = getNewsletterTemplate(templateId);
    const content = createTemplatePostContent(templateId);
    const email = renderNewsletterEmailDocument({
      appUrl: "https://app.bento.surf",
      content,
      products: [],
      presentation: template.presentation,
    });
    const web = renderToStaticMarkup(
      createElement(NewsletterDocument, {
        content,
        subject: template.subject,
        previewText: template.previewText,
        presentation: template.presentation,
      }),
    );
    expect(email.html).toContain(template.presentation.accentColor);
    expect(email.text.length).toBeGreaterThan(0);
    expect(web).toContain(template.subject);
    expect(web).toContain(template.presentation.backgroundColor);
  });

  it("gives copied drafts a unique name and slug within a publication", () => {
    expect(
      uniqueTemplatePostIdentity("Weekly Roundup", [
        { name: "Weekly Roundup", publicSlug: "weekly-roundup" },
        { name: "Weekly Roundup 2", publicSlug: "weekly-roundup-2" },
      ]),
    ).toEqual({ name: "Weekly Roundup 3", publicSlug: "weekly-roundup-3" });
  });

  it("checks persisted snake-case slugs before choosing a duplicate suffix", () => {
    expect(
      uniqueTemplatePostIdentity("Launch", [
        { name: "Different title", public_slug: "launch" },
        { name: "Launch 2", public_slug: "custom-launch" },
      ]),
    ).toEqual({ name: "Launch 3", publicSlug: "launch-3" });
  });
});
