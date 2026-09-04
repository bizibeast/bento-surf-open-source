import { useState } from "react";
import {
  configuredPublicOrigin,
  publicNewsletterPostPath,
  publicNewsletterPublicationPath,
  publicNewslettersPath,
} from "@/lib/application-urls";
import type { NewsletterIssueRecord } from "./NewsletterEditor";
import type { NewsletterSettingsPanel } from "./NewsletterSettings";
import { Switch } from "@/components/ui/switch";
import {
  PublicNewsletterArchiveContent,
  type PublicNewsletterArchiveData,
} from "./PublicNewsletterArchive";

type WebsitePublication = {
  id: string;
  title: string;
  slug: string;
  description?: string | null;
  postal_address?: string;
  status: string;
  accent_color?: string | null;
  paidProduct?: { title?: string; public_slug?: string } | null;
};

type WebsitePost = NewsletterIssueRecord & { published_at?: string | null };

const settingsLinks: Array<{
  label: string;
  panel?: NewsletterSettingsPanel;
  section?: "templates";
}> = [
  { label: "Page details", panel: "details" },
  { label: "SEO", panel: "seo" },
  { label: "Default template", section: "templates" },
];

export function NewsletterWebsite({
  publication,
  archiveData,
  posts,
  bentoAdded,
  onToggleBento,
  onSettings,
  onTemplates,
  onEditPost,
  publicOrigin: requestedPublicOrigin,
}: {
  publication: WebsitePublication;
  archiveData: PublicNewsletterArchiveData | null;
  posts: WebsitePost[];
  bentoAdded: boolean;
  onToggleBento: (enabled: boolean) => void | Promise<void>;
  onSettings?: (panel: NewsletterSettingsPanel) => void;
  onTemplates?: () => void;
  onEditPost?: (postId: string) => void;
  publicOrigin?: string;
}) {
  const [phone, setPhone] = useState(false);
  const [bentoPending, setBentoPending] = useState(false);
  const [bentoMessage, setBentoMessage] = useState("");
  const publicOrigin = configuredPublicOrigin(
    requestedPublicOrigin ?? import.meta.env.VITE_PUBLIC_URL,
  );
  const url = archiveData
    ? `${publicOrigin}${publicNewsletterPublicationPath(archiveData.creator.username, archiveData.publication.slug)}`
    : null;
  const directoryUrl = archiveData
    ? `${publicOrigin}${publicNewslettersPath(archiveData.creator.username)}`
    : null;
  const liveIssues = new Map(archiveData?.issues.map((issue) => [issue.slug, issue.visibility]));
  const actualPages = posts.flatMap((post) => {
    const visibility = post.public_slug ? liveIssues.get(post.public_slug) : null;
    return visibility ? [{ post, visibility }] : [];
  });
  const publicPages = actualPages
    .filter(({ visibility }) => visibility === "public")
    .map(({ post }) => post);
  const paidPages = actualPages
    .filter(({ visibility }) => visibility === "paid")
    .map(({ post }) => post);

  return (
    <section className="space-y-5">
      <header className="flex flex-col gap-3 border-b border-black/[0.08] pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="font-ui-display text-3xl">Website</h2>
          <p className="mt-2 text-sm text-[#17213a]/55">
            {publication.status === "published" ? "Live" : "Draft"} publication archive
          </p>
          {url ? (
            <div className="mt-4 grid gap-2 text-sm">
              <a
                aria-label="Open publication page"
                href={url}
                target="_blank"
                rel="noreferrer"
                className="break-all font-semibold text-[#245fd0] hover:underline"
              >
                {url}
              </a>
              {directoryUrl ? (
                <a
                  aria-label="View all publications"
                  href={directoryUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="w-fit text-xs font-semibold text-[#17213a]/55 hover:text-[#17213a] hover:underline"
                >
                  View all publications
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
        <label className="flex max-w-sm items-center gap-3 rounded-xl border border-black/[0.08] bg-white px-4 py-3">
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-semibold">Show on my Bento page</span>
            <span className="mt-0.5 block text-[11px] leading-4 text-[#17213a]/50">
              Adds a signup card that opens this publication and collects subscribers.
            </span>
          </span>
          <Switch
            checked={bentoAdded}
            aria-label="Show publication on my Bento page"
            onCheckedChange={async (enabled) => {
              if (bentoPending) return;
              setBentoPending(true);
              setBentoMessage("");
              try {
                await onToggleBento(enabled);
                setBentoMessage(
                  bentoAdded ? "Removed from your Bento page." : "Added to your Bento page.",
                );
              } catch (error) {
                setBentoMessage(
                  error instanceof Error ? error.message : "Could not update your Bento page.",
                );
              } finally {
                setBentoPending(false);
              }
            }}
            disabled={!archiveData || bentoPending}
            className="rounded-lg"
          />
        </label>
      </header>
      {bentoMessage ? (
        <p aria-live="polite" className="text-xs text-[#17213a]/55">
          {bentoMessage}
        </p>
      ) : null}

      <div className="flex gap-2" aria-label="Preview size">
        <button
          type="button"
          onClick={() => setPhone(false)}
          className="rounded-lg px-3 py-2 text-xs font-semibold"
        >
          Desktop preview
        </button>
        <button
          type="button"
          onClick={() => setPhone(true)}
          className="rounded-lg px-3 py-2 text-xs font-semibold"
        >
          Phone preview
        </button>
      </div>
      <div className="flex flex-wrap gap-2" aria-label="Website settings">
        {settingsLinks.map(({ label, panel, section }) => (
          <button
            key={panel ?? section}
            type="button"
            onClick={() =>
              section === "templates" ? onTemplates?.() : panel && onSettings?.(panel)
            }
            className="rounded-lg border border-black/[0.08] px-3 py-2 text-xs font-semibold"
          >
            {label}
          </button>
        ))}
      </div>
      <article
        aria-label={phone ? "Phone publication preview" : "Desktop publication preview"}
        className={`overflow-hidden rounded-2xl border border-black/[0.08] bg-white ${phone ? "max-w-sm" : "max-w-3xl"}`}
        style={{ borderTopColor: publication.accent_color ?? undefined, borderTopWidth: 4 }}
      >
        {archiveData ? (
          <PublicNewsletterArchiveContent data={archiveData} emailCaptureInteractive={false} />
        ) : (
          <p className="p-5 text-sm text-[#17213a]/55">Add a username to preview this archive.</p>
        )}
      </article>

      <PostList
        title="Public pages"
        posts={publicPages}
        creatorUsername={archiveData?.creator.username}
        publicationSlug={archiveData?.publication.slug ?? publication.slug}
        publicOrigin={publicOrigin}
        onEditPost={onEditPost}
      />
      <PostList
        title="Paid pages"
        posts={paidPages}
        creatorUsername={archiveData?.creator.username}
        publicationSlug={archiveData?.publication.slug ?? publication.slug}
        publicOrigin={publicOrigin}
        onEditPost={onEditPost}
      />
    </section>
  );
}

function PostList({
  title,
  posts,
  creatorUsername,
  publicationSlug,
  publicOrigin,
  onEditPost,
}: {
  title: string;
  posts: WebsitePost[];
  creatorUsername?: string | null;
  publicationSlug: string;
  publicOrigin: string;
  onEditPost?: (postId: string) => void;
}) {
  return (
    <section className="rounded-2xl border border-black/[0.06] bg-white p-4">
      <h3 className="font-ui-display text-xl">{title}</h3>
      {posts.length ? (
        <ul className="mt-3 grid gap-2 text-sm text-[#17213a]/65">
          {posts.map((post) => (
            <li key={post.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {post.name} · {post.status}
              </span>
              <span className="flex gap-2">
                <button
                  type="button"
                  aria-label={`Edit ${post.name}`}
                  onClick={() => onEditPost?.(post.id)}
                  className="rounded-lg border border-black/[0.08] px-2.5 py-1.5 text-xs font-semibold"
                >
                  Edit
                </button>
                {creatorUsername && post.status === "published" && post.public_slug ? (
                  <a
                    aria-label={`View live page for ${post.name}`}
                    target="_blank"
                    rel="noreferrer"
                    href={`${publicOrigin}${publicNewsletterPostPath(
                      creatorUsername,
                      publicationSlug,
                      post.public_slug,
                    )}`}
                    className="rounded-lg border border-black/[0.08] px-2.5 py-1.5 text-xs font-semibold"
                  >
                    View live page
                  </a>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-[#17213a]/48">None yet.</p>
      )}
    </section>
  );
}
