import {
  ArrowRight,
  ContactRound,
  FileText,
  Globe2,
  ExternalLink,
  Info,
  MoreHorizontal,
  Palette,
  PenLine,
  Settings2,
  UsersRound,
} from "lucide-react";
import type { ComponentType } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { publicNewsletterPostPath } from "@/lib/application-urls";

export type EmailMarketingSection =
  | "overview"
  | "write"
  | "posts"
  | "broadcasts"
  | "templates"
  | "subscribers"
  | "website"
  | "settings";

export type EmailMarketingOverviewPost = {
  id: string;
  name: string;
  status: string;
  delivery_status?: string | null;
  scheduled_at?: string | null;
  updated_at?: string | null;
  opens?: number | null;
  clicks?: number | null;
  public_slug?: string | null;
};

type OverviewPublication = {
  id: string;
  title: string;
  status: string;
  slug?: string;
};

function formatDate(value?: string | null, includeTime = false) {
  if (!value) return "Not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(includeTime ? { hour: "numeric", minute: "2-digit" } : {}),
  }).format(date);
}

function statusLabel(post: EmailMarketingOverviewPost) {
  const status =
    post.delivery_status && post.delivery_status !== "draft" ? post.delivery_status : post.status;
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function SetupRow({
  icon: Icon,
  label,
  detail,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="group flex min-h-16 w-full items-center gap-3 border-t border-black/[0.07] py-3 text-left outline-none first:border-t-0 focus-visible:ring-2 focus-visible:ring-[#3478f6]/30"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#f2f4f8] text-[#17213a]/60">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-[#17213a]">{label}</span>
        <span className="mt-0.5 block text-sm text-[#17213a]/50">{detail}</span>
      </span>
      <ArrowRight className="size-4 shrink-0 text-[#17213a]/35 transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

export function EmailMarketingOverview({
  publication,
  creatorName,
  subscriberCount,
  contactUsage,
  posts,
  locked,
  loading = false,
  error,
  onSectionChange,
}: {
  publication: OverviewPublication | null;
  creatorName?: string | null;
  subscriberCount: number;
  contactUsage: { subscribed: number; limit: number };
  posts: EmailMarketingOverviewPost[];
  locked: boolean;
  loading?: boolean;
  error?: string | null;
  onSectionChange: (section: EmailMarketingSection, postId?: string | null) => void;
}) {
  if (loading) {
    return (
      <div
        role="status"
        aria-label="Loading publication overview"
        className="min-h-64 animate-pulse rounded-xl bg-black/[0.035] motion-reduce:animate-none"
      />
    );
  }

  if (error) {
    return (
      <div role="alert" className="border-y border-red-200 bg-red-50 px-4 py-5 text-red-700">
        {error}
      </div>
    );
  }

  if (!publication) {
    if (locked) {
      return (
        <section className="py-16 text-center">
          <h2 className="font-ui-display text-3xl text-[#17213a]">Email Marketing needs Store</h2>
          <p className="mt-2 text-sm text-[#17213a]/50">
            Review your plan before creating a publication or writing posts.
          </p>
          <a
            href="/settings?section=plan"
            className="mt-5 inline-flex min-h-11 items-center justify-center rounded-lg bg-[#17213a] px-4 text-sm font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-[#3478f6]/35"
          >
            Review plan
          </a>
        </section>
      );
    }
    return (
      <section className="py-16 text-center">
        <h2 className="font-ui-display text-3xl text-[#17213a]">Add your first publication</h2>
        <p className="mt-2 text-sm text-[#17213a]/50">
          Use Add publication above to start writing and collecting subscribers.
        </p>
      </section>
    );
  }

  const draft = posts.find((post) => post.status === "draft");
  const firstRun = publication.status === "draft" && posts.length === 0;

  return (
    <div className="mx-auto max-w-6xl py-8 sm:py-12">
      <section className="flex flex-col gap-6 border-b border-black/[0.08] pb-10 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="font-ui-display text-3xl text-[#17213a] sm:text-4xl">
            Welcome back, {creatorName?.trim() || "creator"}.
          </h2>
          <p className="mt-3 break-words text-base text-[#17213a]/55">
            Here’s what’s happening with <span title={publication.title}>{publication.title}</span>.
          </p>
        </div>
        {locked ? (
          <a
            href="/settings?section=plan"
            className="inline-flex min-h-12 shrink-0 items-center justify-center rounded-lg bg-[#17213a] px-5 text-sm font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-[#3478f6]/35"
          >
            Upgrade to write posts
          </a>
        ) : (
          <button
            type="button"
            onClick={() =>
              draft ? onSectionChange("write", draft.id) : onSectionChange("write", null)
            }
            className="inline-flex min-h-12 shrink-0 items-center justify-center gap-2 rounded-lg bg-[#17213a] px-5 text-sm font-semibold text-white shadow-[0_18px_35px_-22px_rgba(23,33,58,0.9)] outline-none hover:bg-[#263252] focus-visible:ring-2 focus-visible:ring-[#3478f6]/35"
          >
            <PenLine className="size-4" />
            {draft ? "Continue writing" : "Write new post"}
          </button>
        )}
      </section>

      <section
        aria-label="Email Marketing totals"
        className="grid border-b border-black/[0.08] py-8 sm:grid-cols-2 sm:py-9"
      >
        <div className="flex items-center gap-4 py-3 sm:border-r sm:border-black/[0.08] sm:px-2">
          <UsersRound className="size-7 shrink-0 text-[#17213a]/55" />
          <p className="text-[#17213a]/55">
            <strong className="mr-2 font-ui-display text-3xl font-normal text-[#17213a] tabular-nums">
              {subscriberCount}
            </strong>{" "}
            {subscriberCount === 1 ? "subscriber" : "subscribers"} in this publication
          </p>
        </div>
        <div className="flex items-center gap-4 border-t border-black/[0.08] py-3 sm:border-t-0 sm:px-8">
          <ContactRound className="size-7 shrink-0 text-[#17213a]/55" />
          <p className="text-[#17213a]/55">
            <strong className="mr-2 font-ui-display text-3xl font-normal text-[#17213a] tabular-nums">
              {contactUsage.subscribed} / {contactUsage.limit}
            </strong>{" "}
            contacts used across all publications
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="About account-wide contact usage"
                    className="ml-1.5 inline-flex size-5 items-center justify-center rounded-full align-middle text-[#17213a]/45 outline-none hover:text-[#17213a] focus-visible:ring-2 focus-visible:ring-[#3478f6]/35"
                  >
                    <Info className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  The same contact counts once across all publications.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </p>
        </div>
      </section>

      {firstRun ? (
        <section className="pt-10">
          <h3 className="font-ui-display text-2xl text-[#17213a] sm:text-3xl">
            Finish setting up {publication.title}
          </h3>
          <p className="mt-2 text-sm text-[#17213a]/50">
            Complete these essentials, then publish your first post.
          </p>
          <div className="mt-5 border-y border-black/[0.08]">
            <SetupRow
              icon={Settings2}
              label="Publication details"
              detail="Confirm your sender, reply-to email, and postal address."
              onClick={() => onSectionChange("settings")}
            />
            <SetupRow
              icon={Palette}
              label="Choose template"
              detail="Pick the starting style for new posts."
              onClick={() => onSectionChange("templates")}
            />
            <SetupRow
              icon={Globe2}
              label="Publish website"
              detail="Make the publication archive available on the web."
              onClick={() => onSectionChange("website")}
            />
          </div>
        </section>
      ) : (
        <section className="pt-10">
          <div className="flex items-center justify-between gap-4">
            <h3 className="font-ui-display text-2xl text-[#17213a] sm:text-3xl">Recent posts</h3>
            {posts.length ? (
              <button
                type="button"
                onClick={() => onSectionChange("posts")}
                className="inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm font-semibold text-[#17213a] outline-none focus-visible:ring-2 focus-visible:ring-[#3478f6]/30"
              >
                View all posts
                <ArrowRight className="size-4" />
              </button>
            ) : null}
          </div>

          {posts.length ? (
            <div className="mt-5 overflow-x-auto [contain:paint]">
              <table
                aria-label="Recent posts"
                className="w-full min-w-[760px] border-collapse text-left text-sm"
              >
                <thead>
                  <tr className="border-b border-black/[0.09] text-[#17213a]/55">
                    <th scope="col" className="py-3 pr-4 font-semibold">
                      Post
                    </th>
                    <th scope="col" className="px-4 py-3 font-semibold">
                      Status
                    </th>
                    <th scope="col" className="px-4 py-3 font-semibold">
                      Schedule
                    </th>
                    <th scope="col" className="px-4 py-3 font-semibold">
                      Updated
                    </th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">
                      Opens
                    </th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">
                      Clicks
                    </th>
                    <th scope="col" className="py-3 pl-4">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {posts.slice(0, 5).map((post) => (
                    <tr key={post.id} className="border-b border-black/[0.07] text-[#17213a]/65">
                      <td className="max-w-80 py-4 pr-4 font-semibold text-[#17213a]">
                        <span className="block truncate" title={post.name}>
                          {post.name}
                        </span>
                      </td>
                      <td className="px-4 py-4">
                        <span className="inline-flex rounded-md bg-[#f0f2f5] px-2.5 py-1 text-xs font-semibold text-[#17213a]/65">
                          {statusLabel(post)}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-4">
                        {formatDate(post.scheduled_at, true)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-4">{formatDate(post.updated_at)}</td>
                      <td className="px-4 py-4 text-right tabular-nums">
                        {post.opens ?? "Not available"}
                      </td>
                      <td className="px-4 py-4 text-right tabular-nums">
                        {post.clicks ?? "Not available"}
                      </td>
                      <td className="py-4 pl-4 text-right">
                        <span className="inline-flex items-center gap-1">
                          {creatorName &&
                          publication?.slug &&
                          post.status === "published" &&
                          post.public_slug ? (
                            <a
                              href={publicNewsletterPostPath(
                                creatorName,
                                publication.slug,
                                post.public_slug,
                              )}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`View live page for ${post.name}`}
                              className="inline-flex size-10 items-center justify-center rounded-lg outline-none hover:bg-black/[0.04] focus-visible:ring-2 focus-visible:ring-[#3478f6]/30"
                            >
                              <ExternalLink className="size-4" />
                            </a>
                          ) : null}
                          <button
                            type="button"
                            aria-label={`Open ${post.name} in Write`}
                            onClick={() => onSectionChange("write", post.id)}
                            className="inline-flex size-10 items-center justify-center rounded-lg outline-none hover:bg-black/[0.04] focus-visible:ring-2 focus-visible:ring-[#3478f6]/30"
                          >
                            <MoreHorizontal className="size-4" />
                          </button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="mt-5 flex min-h-40 items-center gap-4 border-y border-black/[0.08] py-8 text-[#17213a]/55">
              <FileText className="size-7 shrink-0" />
              <p>No posts yet. Write your first post when you are ready.</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
