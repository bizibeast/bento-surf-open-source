import { ArrowLeft, Check, Search, Sparkles } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  NEWSLETTER_TEMPLATES,
  createTemplatePostContent,
  getNewsletterTemplate,
  type NewsletterTemplateId,
} from "@/lib/newsletter-templates";
import { NewsletterDocument } from "./NewsletterDocument";
import { NewsletterPreview } from "./NewsletterPreview";

export function NewsletterTemplates({
  defaultTemplateId,
  recentTemplateIds = [],
  selectionMode = false,
  onBack,
  onSetDefault,
  onStartPost,
}: {
  defaultTemplateId: NewsletterTemplateId;
  recentTemplateIds?: NewsletterTemplateId[];
  selectionMode?: boolean;
  onBack?: () => void;
  onSetDefault: (id: NewsletterTemplateId) => Promise<void> | void;
  onStartPost: (id: NewsletterTemplateId) => Promise<void> | void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [selectedId, setSelectedId] = useState<NewsletterTemplateId | null>(null);
  const [working, setWorking] = useState<"default" | "post" | null>(null);
  const [message, setMessage] = useState("");

  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return NEWSLETTER_TEMPLATES.filter(
      (template) =>
        (category === "All" || template.category === category) &&
        (!search ||
          template.name.toLowerCase().includes(search) ||
          template.description.toLowerCase().includes(search) ||
          template.category.toLowerCase().includes(search)),
    );
  }, [category, query]);
  const recent = useMemo(
    () =>
      [...new Set(recentTemplateIds)]
        .map((id) => NEWSLETTER_TEMPLATES.find((template) => template.id === id))
        .filter((template): template is (typeof NEWSLETTER_TEMPLATES)[number] => Boolean(template))
        .filter((template) => filtered.includes(template))
        .slice(0, 4),
    [filtered, recentTemplateIds],
  );
  const displayed = selectionMode
    ? [...recent, ...filtered.filter((template) => !recent.includes(template))]
    : filtered;

  const selected = selectedId ? getNewsletterTemplate(selectedId) : null;
  const selectedContent = useMemo(
    () => (selectedId ? createTemplatePostContent(selectedId) : []),
    [selectedId],
  );

  const run = async (action: "default" | "post") => {
    if (!selected || working) return;
    setWorking(action);
    setMessage("");
    try {
      if (action === "default") {
        await onSetDefault(selected.id);
        setMessage(selected.name + " is now the default.");
      } else {
        await onStartPost(selected.id);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That action could not be completed.");
    } finally {
      setWorking(null);
    }
  };

  return (
    <section className="py-8">
      <div className="flex flex-col gap-5 border-b border-black/[0.08] pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          {selectionMode && onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="mb-4 inline-flex items-center gap-2 rounded-lg text-xs font-semibold text-[#17213a]/60 outline-none hover:text-[#17213a] focus-visible:ring-2 focus-visible:ring-[#3478f6]/30"
            >
              <ArrowLeft className="size-4" />
              Back to posts
            </button>
          ) : null}
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-[#17213a]/38">
            Design library
          </p>
          <h2 className="font-ui-display text-3xl text-[#17213a]">
            {selectionMode ? "Choose a template" : "Post templates"}
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-[#17213a]/55">
            Start with a real layout, then change every section in the editor.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-[minmax(260px,1fr)_160px]">
          <label className="relative block">
            <span className="sr-only">Search templates</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#17213a]/38" />
            <input
              type="search"
              aria-label="Search templates"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search templates"
              className="integration-search-input min-h-11 w-full rounded-xl border border-black/[0.08] bg-white pl-11 pr-3 text-sm outline-none focus:border-[#3478f6]/45 focus:ring-2 focus:ring-[#3478f6]/15"
            />
          </label>
          <select
            aria-label="Template category"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            className="min-h-11 rounded-xl border border-black/[0.08] bg-white px-3 text-sm font-semibold text-[#17213a] outline-none focus:border-[#3478f6]/45"
          >
            <option>All</option>
            <option>Editorial</option>
            <option>Business</option>
            <option>Community</option>
            <option>Personal</option>
          </select>
        </div>
      </div>

      <section className="py-7" aria-labelledby="starter-templates-title">
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <h3 id="starter-templates-title" className="text-base font-semibold text-[#17213a]">
              Starter templates
            </h3>
            <p className="mt-1 text-sm text-[#17213a]/48">
              {selectionMode
                ? "Recently used layouts first, followed by the full library."
                : "Long-form layouts for newsletters, launches, stories, and updates."}
            </p>
          </div>
          <span className="text-xs font-semibold text-[#17213a]/40">
            {displayed.length} {displayed.length === 1 ? "template" : "templates"}
          </span>
        </div>

        {displayed.length ? (
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {displayed.map((template, index) => {
              const content = createTemplatePostContent(template.id);
              return (
                <Fragment key={template.id}>
                  {selectionMode && recent.length > 0 && index === 0 ? (
                    <div className="col-span-full">
                      <h3 className="font-semibold text-[#17213a]">Recently used</h3>
                    </div>
                  ) : null}
                  {selectionMode && index === recent.length ? (
                    <div className="col-span-full mt-2 border-t border-black/[0.08] pt-6">
                      <h3 className="font-semibold text-[#17213a]">All templates</h3>
                    </div>
                  ) : null}
                  <article className="group overflow-hidden rounded-2xl border border-black/[0.08] bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
                    <div
                      className="relative h-80 overflow-hidden border-b border-black/[0.07] p-4"
                      style={{ backgroundColor: template.presentation.canvasColor ?? "#eef0f4" }}
                    >
                      <button
                        type="button"
                        aria-label={"Preview " + template.name}
                        onClick={() => setSelectedId(template.id)}
                        className="absolute inset-0 z-10 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#3478f6]"
                      />
                      <div
                        aria-hidden="true"
                        className="pointer-events-none origin-top-left scale-[0.58]"
                        style={{ width: 620 }}
                      >
                        <NewsletterDocument
                          content={content}
                          subject={template.name}
                          previewText={template.previewText}
                          presentation={template.presentation}
                        />
                      </div>
                    </div>
                    <div className="flex min-h-28 items-start justify-between gap-3 p-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="font-semibold text-[#17213a]">{template.name}</h4>
                          {template.id === defaultTemplateId ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-[#eaf8f1] px-2 py-1 text-[11px] font-semibold text-[#168566]">
                              <Check className="size-3" />
                              Default
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-[#17213a]/50">
                          {template.description}
                        </p>
                      </div>
                      <span className="shrink-0 rounded-full bg-[#f2f3f6] px-2 py-1 text-[10px] font-semibold text-[#17213a]/50">
                        {template.category}
                      </span>
                    </div>
                  </article>
                </Fragment>
              );
            })}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-black/[0.12] px-5 py-14 text-center">
            <p className="font-semibold text-[#17213a]">No templates match that search.</p>
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setCategory("All");
              }}
              className="mt-3 text-sm font-semibold text-[#3478f6] underline underline-offset-4"
            >
              Clear filters
            </button>
          </div>
        )}
      </section>

      <Dialog open={Boolean(selected)} onOpenChange={(open) => !open && setSelectedId(null)}>
        <DialogContent className="max-h-[92vh] max-w-5xl overflow-y-auto p-0">
          {selected ? (
            <>
              <DialogHeader className="border-b border-black/[0.08] px-5 py-4 text-left sm:px-6">
                <div className="flex flex-col gap-4 pr-8 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <DialogTitle className="font-ui-display text-2xl">{selected.name}</DialogTitle>
                    <DialogDescription className="mt-1">{selected.description}</DialogDescription>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={selected.id === defaultTemplateId || working !== null}
                      onClick={() => void run("default")}
                      className="min-h-11 rounded-xl border border-black/[0.09] bg-white px-4 text-sm font-semibold text-[#17213a] outline-none focus-visible:ring-2 focus-visible:ring-[#3478f6]/30 disabled:opacity-45"
                    >
                      {working === "default" ? "Saving…" : "Set as default"}
                    </button>
                    <button
                      type="button"
                      disabled={working !== null}
                      onClick={() => void run("post")}
                      className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-[#17213a] px-4 text-sm font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-[#3478f6]/30 disabled:opacity-45"
                    >
                      <Sparkles className="size-4" />
                      {working === "post" ? "Starting…" : "Start writing"}
                    </button>
                  </div>
                </div>
                {message ? (
                  <p aria-live="polite" className="mt-2 text-xs text-[#17213a]/55">
                    {message}
                  </p>
                ) : null}
              </DialogHeader>
              <div
                className="p-4 sm:p-6"
                style={{ backgroundColor: selected.presentation.canvasColor ?? "#eef0f4" }}
              >
                <NewsletterPreview
                  subject={selected.subject}
                  postTitle={selected.name}
                  previewText={selected.previewText}
                  content={selectedContent}
                  templateId={selected.id}
                  publicationName="Your publication"
                  postalAddress="Your sender address"
                  webVisibility="public"
                />
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
