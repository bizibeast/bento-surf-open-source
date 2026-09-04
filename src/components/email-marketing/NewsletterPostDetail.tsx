import { ArrowLeft, Edit3, Eye, MousePointerClick } from "lucide-react";
import { useState } from "react";
import { resolveNewsletterTemplate } from "@/lib/newsletter-templates";
import { NewsletterDocument } from "./NewsletterDocument";
import type { NewsletterPostTableRecord } from "./NewsletterPostsTable";

export function NewsletterPostDetail({
  post,
  publicationName,
  onEdit,
  onBack,
}: {
  post: NewsletterPostTableRecord;
  publicationName: string;
  onEdit: () => void;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<"overview" | "performance" | "interactions">("overview");
  const presentation = resolveNewsletterTemplate(post.template_id)?.presentation;
  const destination = post.web_visibility === "private" ? "Email only" : "Email and web";

  return (
    <section className="py-8">
      <button
        type="button"
        aria-label="Back to Posts"
        onClick={onBack}
        className="inline-flex min-h-10 items-center gap-2 rounded-xl px-2 text-sm font-semibold text-[#17213a]/55 hover:bg-black/[0.04]"
      >
        <ArrowLeft className="size-4" />
        Posts
      </button>

      <header className="mt-4 rounded-2xl border border-black/[0.08] bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.13em] text-[#3478f6]">
              {destination} · {publicationName}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <h2 className="font-ui-display text-3xl text-[#17213a]">{post.name}</h2>
              <span className="rounded-md bg-[#eef0f3] px-2.5 py-1 text-xs font-semibold capitalize text-[#17213a]/65">
                {post.delivery_status && post.delivery_status !== "draft"
                  ? post.delivery_status
                  : post.status}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[#17213a] px-4 text-sm font-semibold text-white"
          >
            <Edit3 className="size-4" />
            Edit post
          </button>
        </div>
      </header>

      <div className="mt-5 overflow-hidden rounded-2xl border border-black/[0.08] bg-white shadow-sm">
        <div
          role="tablist"
          aria-label="Post details"
          className="flex overflow-x-auto border-b border-black/[0.08] bg-[#f7f7f5] p-1.5"
        >
          {(["overview", "performance", "interactions"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={
                "min-h-10 shrink-0 rounded-lg px-4 text-sm font-semibold capitalize " +
                (tab === value ? "bg-white text-[#17213a] shadow-sm" : "text-[#17213a]/48")
              }
            >
              {value}
            </button>
          ))}
        </div>

        {tab === "overview" ? (
          <div>
            <dl className="grid gap-5 border-b border-black/[0.08] p-5 text-sm sm:grid-cols-2 sm:p-6">
              <div>
                <dt className="text-[#17213a]/45">Subject</dt>
                <dd className="mt-1 font-semibold text-[#17213a]">{post.subject}</dd>
              </div>
              <div>
                <dt className="text-[#17213a]/45">Preview text</dt>
                <dd className="mt-1 font-semibold text-[#17213a]">
                  {post.preview_text || "Not added"}
                </dd>
              </div>
            </dl>
            <div
              className="p-4 sm:p-8"
              style={{ backgroundColor: presentation?.canvasColor ?? "#eef0f4" }}
            >
              <NewsletterDocument
                content={post.content}
                subject={post.subject}
                previewText={post.preview_text ?? ""}
                presentation={presentation}
              />
            </div>
          </div>
        ) : tab === "performance" ? (
          <div className="grid gap-4 p-6 sm:grid-cols-2">
            <Metric icon={Eye} label="Opens" value={post.opens} />
            <Metric icon={MousePointerClick} label="Clicks" value={post.clicks} />
          </div>
        ) : (
          <div className="p-12 text-center text-sm text-[#17213a]/48">
            Reader interactions will appear here after this post is sent.
          </div>
        )}
      </div>
    </section>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Eye;
  label: string;
  value?: number | null;
}) {
  return (
    <div className="rounded-xl border border-black/[0.07] p-5">
      <Icon className="size-4 text-[#17213a]/40" />
      <p className="mt-5 text-xs font-semibold uppercase tracking-[0.12em] text-[#17213a]/40">
        {label}
      </p>
      <p className="mt-1 text-3xl font-semibold text-[#17213a]">{value ?? "Not available"}</p>
    </div>
  );
}
