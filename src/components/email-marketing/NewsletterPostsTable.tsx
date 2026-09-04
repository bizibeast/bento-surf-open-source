import { Copy, Edit3, Eye, MoreHorizontal, Search, Send, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { configuredPublicOrigin, publicNewsletterPostPath } from "@/lib/application-urls";
import type { NewsletterIssueRecord } from "./NewsletterEditor";

export type NewsletterPostTableRecord = NewsletterIssueRecord & {
  scheduled_at?: string | null;
  published_at?: string | null;
  updated_at?: string | null;
  opens?: number | null;
  clicks?: number | null;
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

function postStatus(post: NewsletterPostTableRecord) {
  const status =
    post.delivery_status && post.delivery_status !== "draft" ? post.delivery_status : post.status;
  return status === "published" ? "Published" : `${status[0].toUpperCase()}${status.slice(1)}`;
}

export function NewsletterPostsTable({
  posts,
  creatorUsername,
  publicationSlug,
  publicOrigin,
  onEdit,
  onDuplicate,
  onPreview,
  onSchedule,
  onDeleteDraft,
  onStartPost,
  onOpenPost,
}: {
  posts: NewsletterPostTableRecord[];
  creatorUsername?: string | null;
  publicationSlug?: string | null;
  publicOrigin?: string;
  onEdit: (post: NewsletterPostTableRecord) => void;
  onDuplicate: (post: NewsletterPostTableRecord) => Promise<void> | void;
  onPreview: (post: NewsletterPostTableRecord) => void;
  onSchedule: (post: NewsletterPostTableRecord) => void;
  onDeleteDraft: (post: NewsletterPostTableRecord) => Promise<void> | void;
  onStartPost?: () => void;
  onOpenPost?: (post: NewsletterPostTableRecord) => void;
}) {
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const canonicalPublicOrigin = configuredPublicOrigin(publicOrigin);
  const visiblePosts = useMemo(() => {
    const search = query.trim().toLowerCase();
    return posts.filter((post) => {
      const status = postStatus(post).toLowerCase();
      return (
        (filter === "all" || status === filter) &&
        (!search ||
          post.name.toLowerCase().includes(search) ||
          post.subject.toLowerCase().includes(search) ||
          (post.preview_text ?? "").toLowerCase().includes(search))
      );
    });
  }, [filter, posts, query]);
  const run = async (action: () => Promise<void> | void) => {
    setError("");
    try {
      await action();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Could not update post.");
    }
  };

  return (
    <section className="py-8">
      <div className="pb-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="font-ui-display text-3xl text-[#17213a]">Posts</h2>
            <p className="mt-2 text-sm text-[#17213a]/55">
              Find drafts, review published posts, or start something new.
            </p>
          </div>
          {onStartPost ? (
            <button
              type="button"
              onClick={onStartPost}
              className="min-h-11 rounded-xl bg-[#17213a] px-5 text-sm font-semibold text-white shadow-sm"
            >
              Start writing
            </button>
          ) : null}
        </div>
        <div className="mt-6 grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
          <label className="relative block">
            <span className="sr-only">Search posts</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#17213a]/35" />
            <input
              type="search"
              aria-label="Search posts"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search posts"
              className="integration-search-input min-h-11 w-full rounded-xl border border-black/[0.08] bg-white pl-11 pr-3 text-sm outline-none focus:border-[#3478f6]/45 focus:ring-2 focus:ring-[#3478f6]/15"
            />
          </label>
          <select
            aria-label="Filter posts"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            className="min-h-11 rounded-xl border border-black/[0.08] bg-white px-3 text-sm font-semibold text-[#17213a] outline-none focus:border-[#3478f6]/45"
          >
            <option value="all">All posts</option>
            <option value="draft">Drafts</option>
            <option value="scheduled">Scheduled</option>
            <option value="sent">Sent</option>
            <option value="published">Published</option>
          </select>
        </div>
      </div>
      {error ? (
        <p
          role="alert"
          className="border-b border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </p>
      ) : null}

      {posts.length ? (
        <div className="overflow-x-auto rounded-2xl border border-black/[0.08] bg-white px-4 shadow-sm [contain:paint] sm:px-5">
          <table
            aria-label="Posts"
            className="w-full min-w-[920px] border-collapse text-left text-sm"
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
                  Web page
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
                <th scope="col" className="py-3 pl-4 text-right font-semibold">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {visiblePosts.map((post) => {
                const status = postStatus(post);
                const draft =
                  post.status === "draft" && (post.delivery_status ?? "draft") === "draft";
                return (
                  <tr key={post.id} className="border-b border-black/[0.07] text-[#17213a]/65">
                    <td className="max-w-80 py-4 pr-4 font-semibold text-[#17213a]">
                      <button
                        type="button"
                        onClick={() => (onOpenPost ? onOpenPost(post) : onEdit(post))}
                        className="block max-w-full truncate text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[#3478f6]/30"
                        title={post.name}
                      >
                        <span className="block">{post.name}</span>
                        {post.preview_text ? (
                          <span className="mt-1 block truncate text-xs font-normal text-[#17213a]/45">
                            {post.preview_text}
                          </span>
                        ) : null}
                      </button>
                    </td>
                    <td className="px-4 py-4">
                      <span
                        data-status={status.toLowerCase()}
                        className="inline-flex rounded-md bg-[#f0f2f5] px-2.5 py-1 text-xs font-semibold"
                      >
                        {status}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-4">
                      {post.status === "published" &&
                      post.published_at &&
                      post.web_visibility !== "private" &&
                      post.public_slug &&
                      creatorUsername &&
                      publicationSlug ? (
                        <a
                          aria-label={`View live post ${post.name}`}
                          href={`${canonicalPublicOrigin}${publicNewsletterPostPath(
                            creatorUsername,
                            publicationSlug,
                            post.public_slug,
                          )}`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-semibold text-[#245fd0] hover:underline"
                        >
                          View post
                        </a>
                      ) : (
                        <span className="text-[#17213a]/35">-</span>
                      )}
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
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            aria-label={`Actions for ${post.name}`}
                            className="inline-flex size-10 items-center justify-center rounded-lg outline-none hover:bg-black/[0.04] focus-visible:ring-2 focus-visible:ring-[#3478f6]/30"
                          >
                            <MoreHorizontal className="size-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44 rounded-xl p-1.5">
                          <PostAction label="Edit" icon={Edit3} onSelect={() => onEdit(post)} />
                          <PostAction
                            label="Duplicate"
                            icon={Copy}
                            onSelect={() => void run(() => onDuplicate(post))}
                          />
                          <PostAction label="Preview" icon={Eye} onSelect={() => onPreview(post)} />
                          <PostAction
                            label="Schedule"
                            icon={Send}
                            onSelect={() => onSchedule(post)}
                          />
                          {draft ? (
                            <PostAction
                              label="Delete draft"
                              icon={Trash2}
                              destructive
                              onSelect={() => void run(() => onDeleteDraft(post))}
                            />
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex min-h-48 items-center justify-center border-b border-black/[0.08] text-sm text-[#17213a]/50">
          No posts yet. Start with a template or write from scratch.
        </div>
      )}
    </section>
  );
}

function PostAction({
  label,
  icon: Icon,
  destructive = false,
  onSelect,
}: {
  label: string;
  icon: typeof Edit3;
  destructive?: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      className={`min-h-10 rounded-lg ${destructive ? "text-red-600 focus:text-red-600" : ""}`}
    >
      <Icon className="size-4" />
      {label}
    </DropdownMenuItem>
  );
}
