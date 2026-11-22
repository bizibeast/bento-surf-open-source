import { useEffect, useRef, useState } from "react";
import {
  Bookmark,
  Check,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Globe,
  Heart,
  MessageCircle,
  Repeat2,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Zap,
} from "lucide-react";
import { FaLinkedin as Linkedin } from "react-icons/fa6";
import {
  SiFacebook,
  SiInstagram,
  SiReddit,
  SiSubstack,
  SiThreads,
  SiTiktok,
  SiX,
  SiYoutube,
} from "react-icons/si";
import { DiscoverMedia } from "./DiscoverMedia";
import {
  publicSourceUrl,
  discoverAvatarProvider,
  type DiscoverCreator,
  sourceCreator,
  sourcePostEmbed,
  sourceThumbnail,
} from "@/lib/content-source-media";
import { DecodedImage } from "@/components/DecodedImage";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DiscoverPostActionMenu, DiscoverSaveMenu } from "./DiscoverPostActions";
import type { DiscoverRecommendation } from "@/lib/content-discovery.functions";
import {
  discoverMediaLabel,
  discoverPostText,
  relatedDiscoverPosts,
  creatorName,
  formatStat,
  platformName,
  relativePublishedAt,
  visibleStats,
  type DiscoverBoostAction,
  type DiscoverStudioSource,
} from "./discover-utils";

export type DiscoverActions = {
  onLike: (id: string) => void;
  onSave: (id: string) => void;
  onUnsave?: (id: string) => void;
  onReject: (id: string) => void;
  onAskAgent: (item: DiscoverRecommendation, action?: DiscoverBoostAction) => void;
  onCreateDraft: (item: DiscoverRecommendation) => void;
  onCreateStudio?: (source: DiscoverStudioSource) => void;
  onShowSaved: () => void;
  pending: ReadonlySet<string>;
  onResolveCreator?: (item: DiscoverRecommendation) => Promise<DiscoverCreator>;
};

export function PlatformIcon({ item }: { item: DiscoverRecommendation }) {
  const icons = {
    youtube: SiYoutube,
    instagram: SiInstagram,
    facebook: SiFacebook,
    tiktok: SiTiktok,
    twitter: SiX,
    x: SiX,
    threads: SiThreads,
    linkedin: Linkedin,
    reddit: SiReddit,
    substack: SiSubstack,
  };
  const Icon = icons[platformName(item).toLowerCase() as keyof typeof icons] || Globe;
  return <Icon aria-hidden="true" className="size-3.5 shrink-0" />;
}

export function CreatorIdentity({
  item,
  now,
  onClick,
  fullDate = false,
  onResolveCreator,
}: {
  item: DiscoverRecommendation;
  now: Date;
  onClick?: () => void;
  fullDate?: boolean;
  onResolveCreator?: (item: DiscoverRecommendation) => Promise<DiscoverCreator>;
}) {
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const [resolved, setResolved] = useState<DiscoverCreator | null>(null);
  const avatarRef = useRef<HTMLSpanElement>(null);
  const attempted = useRef(new Set<string>());
  const displayItem = resolved ? { ...item, ...resolved } : item;
  const avatar = publicSourceUrl(displayItem.authorAvatarUrl);
  useEffect(() => {
    if (
      !onResolveCreator ||
      !discoverAvatarProvider(item.sourceUrl) ||
      (avatar && failedAvatar !== avatar)
    )
      return;
    const key = `${item.id}:${avatar || "missing"}`;
    if (attempted.current.has(key)) return;
    let active = true;
    const resolve = () => {
      if (attempted.current.has(key)) return;
      attempted.current.add(key);
      void onResolveCreator(item)
        .then((value) => {
          if (active) setResolved(value);
        })
        .catch(() => {
          attempted.current.delete(key);
        });
    };
    const node = avatarRef.current;
    if (typeof IntersectionObserver === "undefined" || !node) {
      resolve();
      return () => {
        active = false;
      };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          resolve();
        }
      },
      { rootMargin: "150px" },
    );
    observer.observe(node);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [item, avatar, failedAvatar, onResolveCreator]);
  const date =
    item.sourcePublishedAt && Number.isFinite(Date.parse(item.sourcePublishedAt))
      ? fullDate
        ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
            new Date(item.sourcePublishedAt),
          )
        : relativePublishedAt(item.sourcePublishedAt, now)
      : "Date unavailable";
  const archived = Boolean(
    item.sourcePublishedAt && Date.parse(item.sourcePublishedAt) < now.getTime() - 90 * 86_400_000,
  );
  const content = (
    <>
      <span ref={avatarRef} className="discover-avatar" aria-hidden="true">
        {avatar && failedAvatar !== avatar ? (
          <DecodedImage
            src={avatar}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailedAvatar(avatar)}
          />
        ) : (
          creatorName(displayItem).replace(/^@/, "").slice(0, 2).toUpperCase()
        )}
      </span>
      <span className="discover-identity-text">
        <strong>{creatorName(displayItem)}</strong>
        <span
          title={
            item.sourcePublishedAt && Number.isFinite(Date.parse(item.sourcePublishedAt))
              ? `Published ${new Date(item.sourcePublishedAt).toLocaleDateString()}`
              : "The source did not provide a verified publication date"
          }
        >
          {platformName(item)}
          {date && ` · ${archived ? "Archive · " : ""}${date}`}
        </span>
        {typeof item.stats?.followers === "number" &&
          Number.isFinite(item.stats.followers) &&
          item.stats.followers >= 0 && (
            <small
              className="discover-creator-followers"
              title={`${item.stats.followers.toLocaleString()} reported followers`}
            >
              {formatStat(item.stats.followers)} followers
            </small>
          )}
      </span>
    </>
  );
  return onClick ? (
    <button
      type="button"
      className="discover-identity"
      aria-label={`View creator ${creatorName(displayItem)}`}
      onClick={onClick}
    >
      {content}
    </button>
  ) : (
    <div className="discover-identity">{content}</div>
  );
}

const statIcons = {
  Views: Eye,
  Likes: Heart,
  Comments: MessageCircle,
  Shares: Repeat2,
  Saves: Bookmark,
  "Engagement rate": Zap,
};
function Stats({ item, detail = false }: { item: DiscoverRecommendation; detail?: boolean }) {
  const stats = visibleStats(item);
  const hasBaseline = Boolean(item.performanceBaseline);
  return (
    <div className={detail ? "discover-detail-stats" : "discover-stats"}>
      {detail && hasBaseline && <Outlier item={item} detail />}
      {(detail ? stats : stats.slice(0, 2)).map(([label, value]) => {
        const Icon = statIcons[label];
        return (
          <span
            key={label}
            className={detail ? "discover-stat-tile" : "discover-stat"}
            title={`${formatStat(value, label === "Engagement rate")} ${label.toLowerCase()}`}
          >
            <span>
              <Icon aria-hidden="true" />
              {formatStat(value, label === "Engagement rate")}
            </span>
            {detail && <small>{label.toLowerCase()}</small>}
          </span>
        );
      })}
      {!detail && hasBaseline && <Outlier item={item} />}
      {!stats.length && !hasBaseline && (
        <span className="discover-metrics-unavailable">Metrics unavailable</span>
      )}
    </div>
  );
}

function Outlier({ item, detail = false }: { item: DiscoverRecommendation; detail?: boolean }) {
  const baseline = item.performanceBaseline;
  if (!baseline) return null;
  const ratio = baseline.ratio.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const description = `${ratio}× median ${baseline.metric} of ${baseline.sampleSize} ${baseline.format} posts from this creator observed within ${baseline.ageWindow.minDays}–${baseline.ageWindow.maxDays} days after publication.`;
  return (
    <span
      className={detail ? "discover-stat-tile discover-outlier" : "discover-outlier"}
      title={description}
    >
      <span>
        <Zap aria-hidden="true" />
        {ratio}×
      </span>
      {detail && (
        <small>
          median {baseline.metric} · {baseline.sampleSize} posts
        </small>
      )}
    </span>
  );
}

export function DiscoverPostCard({
  item,
  now,
  actions,
  onOpen,
  onCreator,
  curated = false,
}: {
  item: DiscoverRecommendation;
  now: Date;
  actions: DiscoverActions;
  onOpen: (item: DiscoverRecommendation) => void;
  onCreator: (item: DiscoverRecommendation) => void;
  curated?: boolean;
}) {
  const hasMedia = Boolean(
    sourceThumbnail(item) || sourcePostEmbed(item.sourceUrl) || item.media?.length,
  );
  const mediaFirst =
    hasMedia &&
    (item.mediaType === "video" ||
      ["youtube", "tiktok", "instagram"].includes(platformName(item).toLowerCase()));
  const image = hasMedia ? <DiscoverMedia item={item} /> : null;
  const sourceUrl = publicSourceUrl(item.sourceUrl);
  const summaryBody = item.summary.startsWith(item.title)
    ? item.summary.slice(item.title.length).trim()
    : item.summary;
  return (
    <article aria-label={item.title} className="discover-card">
      <button
        type="button"
        className="discover-card-open"
        onClick={() => onOpen(item)}
        aria-label={`View details for ${item.title}`}
      />
      <div className="discover-card-actions" aria-label={`Actions for ${item.title}`}>
        <button
          type="button"
          className="discover-icon-button"
          aria-label="More like this"
          title="More like this"
          aria-pressed={item.feedback === "liked"}
          disabled={actions.pending.has(item.id)}
          onClick={() => actions.onLike(item.id)}
        >
          <ThumbsUp />
        </button>
        <button
          type="button"
          className="discover-icon-button"
          aria-label="Less like this"
          title="Less like this"
          disabled={actions.pending.has(item.id)}
          onClick={() => actions.onReject(item.id)}
        >
          <ThumbsDown />
        </button>
        <DiscoverPostActionMenu item={item} actions={actions} />
        <DiscoverSaveMenu item={item} actions={actions} />
      </div>
      {mediaFirst && image}
      <div className="discover-card-body">
        <CreatorIdentity
          item={item}
          now={now}
          onClick={() => onCreator(item)}
          onResolveCreator={actions.onResolveCreator}
        />
        {item.kind === "idea" && <span className="discover-idea-label">Draft idea</span>}
        <h3 className={mediaFirst ? "discover-video-title" : "discover-post-title"}>
          {item.title}
        </h3>
        {!mediaFirst && summaryBody && <p className="discover-post-summary">{summaryBody}</p>}
        {!mediaFirst && image}
        {curated && item.reason && (
          <p className="discover-curation-reason">
            <Sparkles aria-hidden="true" />
            {item.reason}
          </p>
        )}
        <div className="discover-card-footer">
          <Stats item={item} />
          {sourceUrl ? (
            <a
              className="discover-source"
              href={sourceUrl}
              target="_blank"
              rel="noreferrer noopener"
              aria-label="Open original source"
              title={`Open on ${platformName(item)}`}
            >
              <PlatformIcon item={item} />
              <span>
                View {discoverMediaLabel(item).toLowerCase() === "reel" ? "reel" : "post"}
              </span>
              <ExternalLink className="size-3" />
            </a>
          ) : (
            <PlatformIcon item={item} />
          )}
        </div>
      </div>
    </article>
  );
}

function CopyButton({ text, compact = false }: { text: string; compact?: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("error");
    }
  };
  return (
    <button
      type="button"
      className={compact ? "discover-copy" : "discover-detail-action"}
      onClick={() => void copy()}
      aria-label={compact ? "Copy" : "Copy text"}
    >
      {state === "copied" ? <Check /> : <Copy />}
      <span role={state !== "idle" ? "status" : undefined}>
        {state === "copied"
          ? "Copied"
          : state === "error"
            ? "Copy failed"
            : compact
              ? "Copy"
              : "Copy text"}
      </span>
    </button>
  );
}

export function DiscoverPostDialog({
  item,
  items,
  now,
  actions,
  onClose,
  onOpen,
  onCreator,
  actionError,
  onRestoreFocus,
}: {
  item: DiscoverRecommendation | null;
  items: DiscoverRecommendation[];
  now: Date;
  actions: DiscoverActions;
  onClose: () => void;
  onOpen: (item: DiscoverRecommendation) => void;
  onCreator: (item: DiscoverRecommendation) => void;
  actionError?: string | null;
  onRestoreFocus?: () => void;
}) {
  const authorUrl = item && (publicSourceUrl(item.authorUrl) || sourceCreator(item.sourceUrl)?.url);
  const related = item ? relatedDiscoverPosts(item, items) : [];
  const sourceUrl = publicSourceUrl(item?.sourceUrl);
  return (
    <Dialog open={Boolean(item)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="discover-dialog max-h-[90dvh] w-[calc(100vw-1.5rem)]"
        overlayClassName="discover-overlay"
        onCloseAutoFocus={(event) => {
          if (onRestoreFocus) {
            event.preventDefault();
            onRestoreFocus();
          }
        }}
      >
        {item && (
          <div key={item.id}>
            <div className="discover-dialog-heading">
              <PlatformIcon item={item} />
              <DialogTitle>{item.title}</DialogTitle>
              <DialogDescription className="sr-only">
                Post details, source metrics, and actions for {creatorName(item)}.
              </DialogDescription>
            </div>
            <div className="discover-dialog-body">
              <div className="discover-detail-preview">
                <DiscoverMedia item={item} detail />
                <CreatorIdentity
                  item={item}
                  now={now}
                  onResolveCreator={actions.onResolveCreator}
                  fullDate
                  onClick={() => {
                    onClose();
                    onCreator(item);
                  }}
                />
                {authorUrl && (
                  <a
                    className="discover-profile-link"
                    href={authorUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Open creator profile <ExternalLink className="size-3" />
                  </a>
                )}
              </div>
              <div className="discover-detail-actions">
                <DiscoverSaveMenu item={item} actions={actions} detail />
                <DiscoverPostActionMenu item={item} actions={actions} detail />
                <button
                  type="button"
                  className="discover-detail-action"
                  disabled={actions.pending.has(item.id)}
                  onClick={() => actions.onReject(item.id)}
                >
                  <EyeOff />
                  <span>Hide</span>
                </button>
                <CopyButton text={discoverPostText(item)} />
                {sourceUrl && (
                  <a
                    className="discover-detail-action"
                    href={sourceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    aria-label="Open original post"
                  >
                    <ExternalLink />
                    <span>Open on {platformName(item)}</span>
                  </a>
                )}
              </div>
              {actionError && (
                <p className="discover-error" role="alert">
                  {actionError}
                </p>
              )}
              <Stats item={item} detail />
              <section className="discover-text-panel" aria-label="Post text">
                <div className="discover-panel-heading">
                  <h3>Post text</h3>
                  <CopyButton compact text={discoverPostText(item)} />
                </div>
                <p>{discoverPostText(item)}</p>
              </section>
              {(item.reason || item.angles.length > 0) && (
                <details className="discover-context">
                  <summary>Why this post · Ideas to try</summary>
                  {item.reason && <p>{item.reason}</p>}
                  {item.angles.length > 0 && (
                    <ul>
                      {item.angles.map((angle) => (
                        <li key={angle}>{angle}</li>
                      ))}
                    </ul>
                  )}
                </details>
              )}
              {related.length > 0 && <RelatedPosts key={item.id} posts={related} onOpen={onOpen} />}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RelatedPosts({
  posts,
  onOpen,
}: {
  posts: DiscoverRecommendation[];
  onOpen: (post: DiscoverRecommendation) => void;
}) {
  const [visible, setVisible] = useState(12);
  return (
    <section aria-label="Related posts" className="discover-related">
      <h3>
        Related <span>{posts.length} posts</span>
      </h3>
      <div>
        {posts.slice(0, visible).map((post) => (
          <RelatedPost key={post.id} post={post} onOpen={onOpen} />
        ))}
      </div>
      {visible < posts.length && (
        <button
          type="button"
          className="discover-related-more"
          onClick={() => setVisible((count) => count + 12)}
        >
          Show more posts
        </button>
      )}
    </section>
  );
}

function RelatedPost({
  post,
  onOpen,
}: {
  post: DiscoverRecommendation;
  onOpen: (post: DiscoverRecommendation) => void;
}) {
  const thumbnail = sourceThumbnail(post);
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      className="discover-related-card"
      aria-label={`View related post: ${post.title}`}
      onClick={() => onOpen(post)}
    >
      <span className="discover-related-thumbnail">
        {thumbnail && !failed ? (
          <DecodedImage
            src={thumbnail}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
          />
        ) : (
          <span className="discover-related-placeholder">
            <PlatformIcon item={post} />
            <span>{discoverMediaLabel(post)}</span>
          </span>
        )}
        <span className="discover-media-badge">{discoverMediaLabel(post)}</span>
      </span>
      <span className="discover-related-body">
        <small>{creatorName(post)}</small>
        <p>{post.title}</p>
        <Stats item={post} />
      </span>
    </button>
  );
}
