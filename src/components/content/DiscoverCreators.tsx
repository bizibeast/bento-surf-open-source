import { useState } from "react";
import { Check, ChevronRight, ExternalLink, Plus, Star } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { DiscoverRecommendation } from "@/lib/content-discovery.functions";
import {
  creatorMatchesSource,
  normalizeDiscoverCreator,
  type TrackedDiscoverCreator,
} from "@/lib/content-discover-creators";
import { sourceCreator, type DiscoverCreator } from "@/lib/content-source-media";
import { CreatorIdentity } from "./DiscoverPost";
import type { SuggestedDiscoverCreator } from "@/lib/content-discover-personalization";
import { discoverPostKey, uniqueDiscoverPosts } from "@/lib/content-discover-identity";
import { creatorKey, creatorName } from "./discover-utils";

export type TrackCreatorInput = { profileUrl: string; name?: string; topics?: string };

export function DiscoverCreators({
  items,
  suggestions = [],
  creators,
  now,
  search,
  platform,
  onOpen,
  onTrack,
  onUntrack,
  onResolveCreator,
}: {
  items: DiscoverRecommendation[];
  suggestions?: SuggestedDiscoverCreator[];
  creators: TrackedDiscoverCreator[];
  now: Date;
  search: string;
  platform: string;
  onOpen: (item: DiscoverRecommendation) => void;
  onTrack?: (input: TrackCreatorInput) => Promise<void>;
  onUntrack?: (id: string) => Promise<void>;
  onResolveCreator?: (item: DiscoverRecommendation) => Promise<DiscoverCreator>;
}) {
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [topics, setTopics] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (key: string, action: () => Promise<void>) => {
    if (pending) return;
    setPending(key);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not update this creator. Try again.",
      );
    } finally {
      setPending(null);
    }
  };
  const rows = creators.map((creator) => {
    const post = items.find((item) => creatorMatchesSource(creator, item));
    const item: DiscoverRecommendation = {
      ...post,
      id: `tracked:${creator.id}`,
      fingerprint: creator.id,
      kind: "trend",
      title: creator.name,
      summary: "",
      sourceUrl: null,
      sourceName: creator.platform,
      sourcePublishedAt: null,
      sourceRetrievedAt: null,
      reason: "",
      angles: [],
      metricName: null,
      metricValue: null,
      outlierScore: null,
      feedback: "pending",
      platform: creator.platform,
      author: creator.name,
      authorUrl: creator.profileUrl,
      authorAvatarUrl:
        creator.avatarUrl ||
        (post?.authorUrl?.replace(/\/$/, "") === creator.profileUrl ? post.authorAvatarUrl : null),
    };
    return { creator, item };
  });
  const recommended = suggestions.filter(
    (item) =>
      !creators.some((follow) => creatorMatchesSource(follow, { authorUrl: item.profileUrl })) &&
      (platform === "all" || item.platform === platform) &&
      `${item.name} ${item.description} ${item.topics.join(" ")} ${item.reason}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  const suggested = [
    ...new Map(
      uniqueDiscoverPosts(items)
        .filter((item) => !creators.some((creator) => creatorMatchesSource(creator, item)))
        .filter((item) => !recommended.some((creator) => creatorMatchesSource(creator, item)))
        .filter(
          (item) =>
            (platform === "all" || (item.platform || item.sourceName) === platform) &&
            `${creatorName(item)} ${item.reason}`
              .toLowerCase()
              .includes(search.trim().toLowerCase()),
        )
        .sort((a, b) => (a.relevanceScore || 0) - (b.relevanceScore || 0))
        .map((item) => [creatorKey(item), item]),
    ).values(),
  ].sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));
  const card = (
    item: DiscoverRecommendation,
    creator?: TrackedDiscoverCreator,
    suggestion?: SuggestedDiscoverCreator,
  ) => {
    const profileUrl = creator?.profileUrl || item.authorUrl || sourceCreator(item.sourceUrl)?.url;
    let trackable = false;
    try {
      if (profileUrl) {
        normalizeDiscoverCreator(profileUrl);
        trackable = true;
      }
    } catch {
      /* Unsupported creator source. */
    }
    const postCount = new Set(
      items
        .filter((post) =>
          creator || suggestion
            ? creatorMatchesSource((creator || suggestion)!, post)
            : creatorKey(post) === creatorKey(item),
        )
        .map(discoverPostKey),
    ).size;
    return (
      <div
        key={creator?.id || creatorKey(item)}
        className="discover-creator-card"
        data-tracked={Boolean(creator)}
      >
        <CreatorIdentity
          item={item}
          now={now}
          onClick={postCount ? () => onOpen(item) : undefined}
          onResolveCreator={item.sourceUrl ? onResolveCreator : undefined}
        />
        {suggestion && (
          <span className="discover-creator-label">
            {suggestion.source === "brain" ? "Picked from your Brain" : "Established creator"}
          </span>
        )}
        {suggestion && <p>{suggestion.description}</p>}
        {suggestion && <p className="discover-creator-reason">{suggestion.reason}</p>}
        {!suggestion && !creator && item.reason && (
          <p className="discover-creator-reason">{item.reason}</p>
        )}
        {creator?.topics && <p className="discover-creator-topics">{creator.topics}</p>}
        <p>
          {postCount
            ? `${postCount} ${postCount === 1 ? "post" : "posts"} in your feed`
            : creator
              ? "No public posts found yet"
              : "Track to discover their public posts"}
        </p>
        {creator?.lastError && <p role="status">{creator.lastError}</p>}
        {creator && !creator.lastCheckedAt && <p>Finding public posts…</p>}
        <div className="discover-creator-actions">
          {(postCount > 0 || creator) && (
            <button type="button" onClick={() => onOpen(item)}>
              View posts <ChevronRight className="size-3.5" />
            </button>
          )}
          {creator && onUntrack ? (
            <button
              type="button"
              aria-label={`Untrack ${creator.name}`}
              disabled={Boolean(pending)}
              onClick={() => void run(creator.id, () => onUntrack(creator.id))}
            >
              <Check /> Tracking
            </button>
          ) : (
            onTrack &&
            trackable && (
              <button
                type="button"
                aria-label={`Track ${creatorName(item)}`}
                disabled={Boolean(pending)}
                onClick={() =>
                  void run(item.id, () =>
                    onTrack({
                      profileUrl: profileUrl!,
                      name: creatorName(item),
                      ...(suggestion ? { topics: suggestion.topics.join(", ") } : {}),
                    }),
                  )
                }
              >
                <Plus /> Track
              </button>
            )
          )}
          {profileUrl && (
            <a
              href={profileUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open ${creatorName(item)} profile`}
            >
              <ExternalLink /> {suggestion && "Open profile"}
            </a>
          )}
        </div>
      </div>
    );
  };
  return (
    <>
      <div className="discover-creators-heading">
        <div>
          <h3>
            <Star /> Your favorites
          </h3>
          <p>Track creators and communities. Their public posts shape your feed and ideas.</p>
        </div>
        {onTrack && (
          <button
            type="button"
            className="discover-add-creator"
            onClick={() => {
              setError(null);
              setAdding(true);
            }}
          >
            <Plus /> Add creator
          </button>
        )}
      </div>
      {error && !adding && (
        <p role="alert" className="discover-error">
          {error}
        </p>
      )}
      <div className="discover-creators">
        {rows
          .filter(
            ({ creator }) =>
              (platform === "all" || creator.platform === platform) &&
              `${creator.name} ${creator.platform} ${creator.topics}`
                .toLowerCase()
                .includes(search.toLowerCase()),
          )
          .map(({ item, creator }) => card(item, creator))}
      </div>
      {!creators.length && !recommended.length && (
        <div className="discover-follow-empty">
          <Star />
          <h3>Build your inspiration circle</h3>
          <p>
            Add a favorite creator, a Facebook page, or a Reddit community to follow their public
            posts here.
          </p>
        </div>
      )}
      {recommended.length > 0 && (
        <>
          <div className="discover-creators-heading">
            <div>
              <h3>Recommended for you</h3>
              <p>Established voices matched to your direction, Brain, and saved inspiration.</p>
            </div>
          </div>
          <div className="discover-creators">
            {recommended.map((suggestion) =>
              card(
                {
                  id: suggestion.id,
                  fingerprint: suggestion.id,
                  kind: "trend",
                  title: suggestion.name,
                  summary: suggestion.description,
                  sourceUrl: null,
                  sourceName: suggestion.platform,
                  platform: suggestion.platform,
                  author: suggestion.name,
                  authorUrl: suggestion.profileUrl,
                  sourcePublishedAt: null,
                  sourceRetrievedAt: null,
                  reason: suggestion.reason,
                  angles: [],
                  metricName: null,
                  metricValue: null,
                  outlierScore: null,
                  feedback: "pending",
                },
                undefined,
                suggestion,
              ),
            )}
          </div>
        </>
      )}
      {suggested.length > 0 && (
        <>
          <div className="discover-creators-heading">
            <h3>From your feed</h3>
          </div>
          <div className="discover-creators">{suggested.map((item) => card(item))}</div>
        </>
      )}
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="discover-track-dialog">
          <DialogTitle>Track a creator</DialogTitle>
          <DialogDescription>
            Add a public profile, Facebook page, or Reddit community. Bento finds their posts and
            suggests angles for your own content.
          </DialogDescription>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run("add", async () => {
                const normalized = normalizeDiscoverCreator(url);
                await onTrack?.({
                  profileUrl: normalized.profileUrl,
                  name: name || normalized.name,
                  topics,
                });
                setAdding(false);
                setUrl("");
                setName("");
                setTopics("");
              });
            }}
          >
            <label>
              Profile or community URL
              <input
                autoFocus
                required
                type="url"
                placeholder="https://www.reddit.com/r/Entrepreneur"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                maxLength={500}
              />
            </label>
            <label>
              Name <span>(optional)</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="How you know this creator"
                maxLength={120}
              />
            </label>
            <label>
              What interests you <span>(optional)</span>
              <input
                value={topics}
                onChange={(event) => setTopics(event.target.value)}
                placeholder="e.g. founder stories, practical AI workflows"
                maxLength={200}
              />
            </label>
            <p>
              Facebook, Reddit, Instagram, X, Threads, LinkedIn, YouTube and TikTok. Public posts
              only.
            </p>
            {error && (
              <p role="alert" className="discover-error">
                {error}
              </p>
            )}
            <button type="submit" className="discover-add-creator" disabled={Boolean(pending)}>
              {pending ? "Adding creator…" : "Track creator"}
            </button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
