import type { NewsletterTemplatePresentation } from "@/lib/newsletter-templates";

export const newsletterParagraphClassName = "whitespace-pre-wrap text-sm leading-6";

export function newsletterHeadingClassName(presentation?: NewsletterTemplatePresentation) {
  return `${presentation?.headingStyle === "sans" ? "font-ui-sans" : "font-ui-display"} text-xl font-semibold`;
}

export function newsletterDocumentClassName(presentation?: NewsletterTemplatePresentation) {
  return `mx-auto overflow-hidden rounded-2xl px-5 text-[#17213a] shadow-sm sm:px-8 ${presentation?.density === "compact" ? "py-5" : "py-6"}`;
}

export function newsletterContentClassName(presentation?: NewsletterTemplatePresentation) {
  return presentation?.density === "compact" ? "mt-6 space-y-4" : "mt-7 space-y-6";
}
