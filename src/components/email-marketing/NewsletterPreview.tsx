import { useMemo, useRef, useState } from "react";
import { renderBentoEmail } from "@/lib/email-templates";
import { configuredPublicOrigin } from "@/lib/application-urls";
import type { NewsletterContentBlock } from "@/lib/newsletter";
import { resolveNewsletterTemplate, type NewsletterTemplateId } from "@/lib/newsletter-templates";
import {
  NewsletterDocument,
  NewsletterPaidPost,
  type NewsletterDocumentProduct,
  type NewsletterPaidProduct,
} from "./NewsletterDocument";

export type NewsletterPreviewMode = "email-desktop" | "email-mobile" | "web-page";

const modes: Array<{ id: NewsletterPreviewMode; label: string; width: number }> = [
  { id: "email-desktop", label: "Email desktop", width: 600 },
  { id: "email-mobile", label: "Email mobile", width: 390 },
  { id: "web-page", label: "Web page", width: 672 },
];

export function NewsletterPreview({
  subject,
  postTitle,
  previewText,
  content,
  products = [],
  templateId,
  publicationName = "Publication",
  publicationLogoUrl,
  postalAddress = "",
  webVisibility = "private",
  paidProduct,
  mode,
  onModeChange,
}: {
  subject: string;
  postTitle?: string;
  previewText: string;
  content: NewsletterContentBlock[];
  products?: NewsletterDocumentProduct[];
  templateId?: NewsletterTemplateId | null;
  publicationName?: string;
  publicationLogoUrl?: string | null;
  postalAddress?: string;
  webVisibility?: "private" | "public" | "paid";
  paidProduct?: NewsletterPaidProduct | null;
  mode?: NewsletterPreviewMode;
  onModeChange?: (mode: NewsletterPreviewMode) => void;
}) {
  const [localMode, setLocalMode] = useState<NewsletterPreviewMode>("email-desktop");
  const activeMode = mode ?? localMode;
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const active = modes.find((candidate) => candidate.id === activeMode) ?? modes[0];
  const presentation = resolveNewsletterTemplate(templateId)?.presentation;
  const publicOrigin = configuredPublicOrigin(import.meta.env.VITE_PUBLIC_URL);
  const email = useMemo(
    () =>
      renderBentoEmail({
        eventType: "creator_campaign",
        category: "marketing",
        payload: {
          subject,
          postTitle: postTitle || subject,
          body: previewText,
          creatorName: publicationName,
          newsletterLogoUrl: publicationLogoUrl || null,
          creatorUrl: publicOrigin,
          newsletterContent: content,
          newsletterProducts: products,
          newsletterTemplateId: templateId,
          postalAddress,
        },
        appUrl: publicOrigin,
        publicUrl: publicOrigin,
        unsubscribeUrl: `${publicOrigin}/unsubscribe`,
      }),
    [
      content,
      postalAddress,
      postTitle,
      previewText,
      publicOrigin,
      products,
      publicationLogoUrl,
      publicationName,
      subject,
      templateId,
    ],
  );

  const selectMode = (nextMode: NewsletterPreviewMode, focus = false) => {
    if (mode === undefined) setLocalMode(nextMode);
    onModeChange?.(nextMode);
    if (focus) tabRefs.current[modes.findIndex((candidate) => candidate.id === nextMode)]?.focus();
  };

  const moveMode = (currentIndex: number, key: string) => {
    let nextIndex = currentIndex;
    if (key === "ArrowRight") nextIndex = (currentIndex + 1) % modes.length;
    else if (key === "ArrowLeft") nextIndex = (currentIndex - 1 + modes.length) % modes.length;
    else if (key === "Home") nextIndex = 0;
    else if (key === "End") nextIndex = modes.length - 1;
    else return;
    selectMode(modes[nextIndex].id, true);
  };

  return (
    <div className="min-w-0">
      <div
        role="tablist"
        aria-label="Preview mode"
        className="mx-auto mb-4 flex w-fit rounded-xl bg-[#eef0f4] p-1"
      >
        {modes.map((previewMode, index) => (
          <button
            key={previewMode.id}
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            type="button"
            role="tab"
            aria-selected={activeMode === previewMode.id}
            tabIndex={activeMode === previewMode.id ? 0 : -1}
            onClick={() => selectMode(previewMode.id)}
            onKeyDown={(event) => moveMode(index, event.key)}
            className={`rounded-lg px-3 py-2 text-xs font-semibold ${
              activeMode === previewMode.id
                ? "bg-white text-[#17213a] shadow-sm"
                : "text-[#17213a]/48"
            }`}
          >
            {previewMode.label}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto rounded-2xl bg-[#eef0f4] p-3 sm:p-5 [contain:paint]">
        <div
          data-testid="newsletter-preview-canvas"
          data-preview-mode={activeMode}
          className="mx-auto max-w-full overflow-hidden rounded-2xl bg-white shadow-sm"
          style={{ width: `${active.width}px` }}
        >
          {activeMode === "web-page" ? (
            <div className="bg-[#f7f7f5] p-3 sm:p-5">
              {webVisibility === "paid" ? (
                <NewsletterPaidPost
                  subject={postTitle || subject}
                  previewText={previewText}
                  paidProduct={paidProduct}
                />
              ) : (
                <NewsletterDocument
                  subject={subject}
                  previewText={previewText}
                  content={content}
                  products={products}
                  presentation={presentation}
                />
              )}
            </div>
          ) : (
            <iframe
              title={`${active.label} preview`}
              srcDoc={email.html}
              sandbox=""
              className="block h-[720px] w-full border-0 bg-white"
            />
          )}
        </div>
      </div>
    </div>
  );
}
