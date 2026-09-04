import { Link } from "@tanstack/react-router";
import { publicProductPath } from "@/lib/application-urls";
import { scheduleNewsletterIssue, sendAudienceCampaignTest } from "@/lib/commerce-growth.functions";
import { resolveNewsletterTemplate, type NewsletterTemplateId } from "@/lib/newsletter-templates";
import { NewsletterDocument } from "./NewsletterDocument";
import { NewsletterEditor, type NewsletterIssueRecord } from "./NewsletterEditor";

export interface NewsletterPublicationRecord {
  id: string;
  title: string;
  default_template_id?: NewsletterTemplateId;
  postal_address: string;
  logo_url?: string | null;
  paidProduct?: { title?: string; public_slug?: string };
}

export function NewsletterWorkspace({
  publication,
  issues,
  products = [],
  creatorUsername,
  selectedPostId,
  recipientCounts,
  audiences = [],
  locked,
  onBack,
  onRefresh,
}: {
  publication: NewsletterPublicationRecord | null;
  issues: NewsletterIssueRecord[];
  products?: Array<{
    id: string;
    title: string;
    description: string | null;
    public_slug: string;
    price_amount: number;
    currency: string;
    billing_interval: string | null;
  }>;
  creatorUsername?: string | null;
  selectedPostId?: string | null;
  recipientCounts?: Record<string, number>;
  audiences?: Array<{ id: string; name: string }>;
  locked: boolean;
  onBack?: () => void;
  onRefresh: () => void | Promise<void>;
}) {
  const selectedIssue =
    selectedPostId === null
      ? undefined
      : selectedPostId
        ? issues.find((candidate) => candidate.id === selectedPostId)
        : issues[0];

  if (locked) {
    return (
      <section className="rounded-2xl border border-black/[0.06] bg-white p-5 text-center shadow-sm">
        <h2 className="font-ui-display text-2xl">Publish newsletters</h2>
        <p className="mx-auto mt-2 max-w-lg text-sm text-[#17213a]/48">
          Email marketing is available on the Creator plan.
        </p>
        <Link
          to="/settings"
          search={{ section: "plan" }}
          className="mt-5 inline-flex rounded-xl bg-[#17213a] px-4 py-2.5 text-xs font-semibold text-white"
        >
          View plans
        </Link>
      </section>
    );
  }

  if (!publication) {
    return (
      <section className="rounded-2xl border border-black/[0.06] bg-white p-5 text-center shadow-sm">
        <h2 className="font-ui-display text-2xl">Select a publication</h2>
        <p className="mx-auto mt-2 max-w-lg text-sm text-[#17213a]/48">
          Add or select a publication before writing a post.
        </p>
      </section>
    );
  }

  const paidProduct =
    publication.paidProduct?.title && publication.paidProduct.public_slug && creatorUsername
      ? {
          title: publication.paidProduct.title,
          url: publicProductPath(creatorUsername, publication.paidProduct.public_slug),
        }
      : null;
  const documentProducts = products.map((product) => ({
    id: product.id,
    title: product.title,
    description: product.description ?? "",
    url: creatorUsername ? publicProductPath(creatorUsername, product.public_slug) : "",
    priceAmount: product.price_amount,
    currency: product.currency,
    billingInterval: product.billing_interval,
  }));

  if (selectedIssue?.status === "published") {
    return (
      <section className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-sm sm:p-6">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="mb-5 inline-flex items-center gap-2 rounded-lg text-xs font-semibold text-[#17213a]/60 outline-none hover:text-[#17213a] focus-visible:ring-2 focus-visible:ring-[#3478f6]/30"
          >
            ← Back to posts
          </button>
        ) : null}
        <NewsletterDocument
          content={selectedIssue.content}
          subject={selectedIssue.subject}
          previewText={selectedIssue.preview_text ?? ""}
          products={documentProducts}
          presentation={resolveNewsletterTemplate(selectedIssue.template_id)?.presentation}
        />
      </section>
    );
  }

  return (
    <NewsletterEditor
      key={selectedIssue?.id ?? "new"}
      publicationId={publication.id}
      issue={selectedIssue}
      defaultTemplateId={publication.default_template_id}
      publicationName={publication.title}
      publicationLogoUrl={publication.logo_url}
      postalAddress={publication.postal_address}
      recipientCount={recipientCounts?.all}
      recipientCounts={recipientCounts}
      audiences={audiences}
      paidProduct={paidProduct}
      onBack={onBack}
      onSaved={onRefresh}
      onTestSend={(postId) =>
        sendAudienceCampaignTest({
          data: { publicationId: publication.id, id: postId, kind: "newsletter" },
        }).then(() => undefined)
      }
      onPublish={({ id, scheduledAt }) =>
        scheduleNewsletterIssue({
          data: { id, publicationId: publication.id, scheduledAt, publish: true },
        }).then(() => undefined)
      }
      products={documentProducts}
    />
  );
}
