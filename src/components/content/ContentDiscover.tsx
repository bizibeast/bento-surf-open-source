import { useMemo, useState } from "react";
import {
  Bookmark,
  ExternalLink,
  Lightbulb,
  MessageCircle,
  Search,
  Sparkles,
  RefreshCw,
  ThumbsDown,
  ThumbsUp,
  TrendingUp,
} from "lucide-react";
import { DecodedImage } from "@/components/DecodedImage";
import { MicroAppPanel } from "@/components/MicroAppPanel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  ContentDiscoverData,
  DiscoverRecommendation,
} from "@/lib/content-discovery.functions";
import { micro } from "@/lib/micro-app-ui";

type Feed = "all" | "trends" | "ideas";

export function ContentDiscover({
  data,
  now = new Date(),
  onLike,
  onSave,
  onReject,
  onAskAgent,
  onCreateDraft,
  refreshing = false,
  refreshError = null,
  onRefresh,
}: {
  data: ContentDiscoverData;
  now?: Date;
  onLike: (id: string) => void | Promise<void>;
  onSave: (id: string) => void | Promise<void>;
  onReject: (id: string) => void | Promise<void>;
  onAskAgent: (item: DiscoverRecommendation) => void;
  onCreateDraft: (item: DiscoverRecommendation) => void;
  refreshing?: boolean;
  refreshError?: string | null;
  onRefresh?: () => void;
}) {
  const [feed, setFeed] = useState<Feed>("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<DiscoverRecommendation | null>(null);
  const query = search.trim().toLowerCase();
  const trends = useMemo(
    () => data.trends.filter((item) => recommendationMatches(item, query)),
    [data.trends, query],
  );
  const ideas = useMemo(
    () => data.ideas.filter((item) => recommendationMatches(item, query)),
    [data.ideas, query],
  );
  const resultCount = trends.length + ideas.length;

  return (
    <section aria-labelledby="discover-heading" className="min-h-[calc(100dvh-12rem)]">
      <div className="rounded-[20px] border border-black/[0.07] bg-white p-4 shadow-sm sm:rounded-[28px] sm:p-6">
        <div className="flex flex-col gap-5">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-[#17213a]/32" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Search Discover"
              placeholder="Search ideas, posts, sources, and topics"
              className="h-14 w-full rounded-2xl border border-black/[0.08] bg-[#fbfcff] pl-12 pr-4 text-sm text-[#17213a] outline-none transition focus:border-[#3478f6]/35 focus:ring-4 focus:ring-[#3478f6]/8"
            />
          </label>

          <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
            <div>
              <p className={micro.eyebrow}>Ideas grounded in evidence</p>
              <h2 id="discover-heading" className="mt-1 font-ui-display text-4xl text-[#17213a]">
                Discover
              </h2>
              <p className="mt-2 text-sm text-[#17213a]/48">
                Top-performing public posts in your niche, personalized by what you save and reject.
              </p>
            </div>
            <p className="text-xs font-semibold text-[#17213a]/45">
              {resultCount} niche posts and ideas
            </p>
          </div>

          <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Discover filters">
            {(
              [
                ["all", "For you", Sparkles],
                ["trends", "Top posts", TrendingUp],
                ["ideas", "Ready ideas", Lightbulb],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                aria-pressed={feed === id}
                onClick={() => setFeed(id)}
                className={`inline-flex shrink-0 items-center gap-2 rounded-xl border px-3.5 py-2 text-xs font-semibold transition ${
                  feed === id
                    ? "border-[#17213a] bg-[#17213a] text-white"
                    : "border-black/[0.08] bg-white text-[#17213a]/55 hover:text-[#17213a]"
                }`}
              >
                <Icon className="size-3.5" /> {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {data.warnings.length > 0 && (
        <div className={`${micro.bannerWarn} mt-4`} role="status">
          {data.warnings.join(" ")} Recommendations below use the remaining verified sources.
        </div>
      )}

      {refreshing && (
        <div className={`${micro.bannerInfo} mt-4`} role="status">
          <RefreshCw className="size-4 animate-spin" /> Refreshing recommendations…
        </div>
      )}

      {refreshError && (
        <div
          className={`${micro.bannerWarn} mt-4 flex items-center justify-between gap-4`}
          role="alert"
        >
          <span>{refreshError}</span>
          {onRefresh && (
            <button type="button" onClick={onRefresh} className={micro.btnOutline}>
              Try again
            </button>
          )}
        </div>
      )}

      <div className="mt-4 rounded-[22px] border border-[#3478f6]/18 bg-[#eef5ff] px-5 py-4 sm:flex sm:items-start sm:gap-4">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl bg-white text-[#3478f6] shadow-sm">
          <Bookmark className="size-4" />
        </span>
        <div>
          <p className="font-semibold text-[#17213a]">Save three posts you wish you had made</p>
          <p className="mt-1 text-sm leading-6 text-[#17213a]/52">
            Save or reject recommendations and Bento will personalize this feed around your taste,
            niche, and the formats already working for you.
          </p>
        </div>
      </div>

      <div className="mt-5 columns-1 gap-4 md:columns-2 xl:columns-3">
        {(feed === "all" || feed === "trends") &&
          trends.map((item) => (
            <RecommendationCard
              key={item.id}
              item={item}
              now={now}
              tone="trend"
              onOpen={setSelected}
              onLike={onLike}
              onSave={onSave}
              onReject={onReject}
              onAskAgent={onAskAgent}
              onCreateDraft={onCreateDraft}
            />
          ))}

        {(feed === "all" || feed === "ideas") &&
          ideas.map((item) => (
            <RecommendationCard
              key={item.id}
              item={item}
              now={now}
              tone="idea"
              onOpen={setSelected}
              onLike={onLike}
              onSave={onSave}
              onReject={onReject}
              onAskAgent={onAskAgent}
              onCreateDraft={onCreateDraft}
            />
          ))}
      </div>

      {!resultCount && (
        <Empty
          message={
            data.status === "needs_niche"
              ? "Add niche topics in Brain or connect a social account so Bento knows what to research."
              : refreshing
                ? "Researching top posts in your niche…"
                : "No matching inspiration yet. Try another search."
          }
        />
      )}
      <PostDetailsDialog item={selected} onClose={() => setSelected(null)} />
    </section>
  );
}

function RecommendationCard({
  item,
  now,
  tone,
  onOpen,
  onLike,
  onSave,
  onReject,
  onAskAgent,
  onCreateDraft,
}: {
  item: DiscoverRecommendation;
  now: Date;
  tone: "trend" | "idea";
  onOpen: (item: DiscoverRecommendation) => void;
  onLike: (id: string) => void | Promise<void>;
  onSave: (id: string) => void | Promise<void>;
  onReject: (id: string) => void | Promise<void>;
  onAskAgent: (item: DiscoverRecommendation) => void;
  onCreateDraft: (item: DiscoverRecommendation) => void;
}) {
  return (
    <article aria-label={item.title} className="mb-4 break-inside-avoid">
      <MicroAppPanel className="overflow-hidden p-0 transition hover:-translate-y-0.5 hover:shadow-md">
        <div className={`h-1 ${tone === "trend" ? "bg-[#30a46c]" : "bg-[#3478f6]"}`} />
        {item.thumbnailUrl && (
          <DecodedImage src={item.thumbnailUrl} alt="" className="max-h-80 w-full object-cover" />
        )}
        <div className="p-5">
          <button
            type="button"
            onClick={() => onOpen(item)}
            aria-label={`View details for ${item.title}`}
            className="block w-full text-left"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className={micro.eyebrowMuted}>
                  {item.platform || item.sourceName || "Bento"}
                  {item.author ? ` · ${item.author}` : ""}
                </p>
                <h3 className="mt-2 break-words font-ui-display text-xl leading-7 text-[#17213a]">
                  {item.title}
                </h3>
              </div>
              {item.sourcePublishedAt && (
                <span className="shrink-0 text-[10px] text-[#17213a]/38">
                  {relativePublishedAt(item.sourcePublishedAt, now)}
                </span>
              )}
            </div>
            {item.summary && <p className={`mt-3 line-clamp-4 ${micro.muted}`}>{item.summary}</p>}
            <StatsLine item={item} />
            <p className={`mt-3 ${micro.mutedXs}`}>{item.reason}</p>
            {item.angles.length > 0 && (
              <ul className="mt-4 grid gap-2 text-sm leading-6 text-[#17213a]/68">
                {item.angles.map((angle) => (
                  <li key={angle} className="flex gap-2">
                    <span className="mt-2 size-1.5 shrink-0 rounded-full bg-[#3478f6]" />
                    {angle}
                  </li>
                ))}
              </ul>
            )}
          </button>
          <div className="mt-5 flex flex-wrap gap-2 border-t border-black/[0.06] pt-4">
            <button
              type="button"
              aria-label={`Like ${item.title}`}
              onClick={() => void onLike(item.id)}
              className={micro.btnSoft}
            >
              <ThumbsUp className="size-3.5" /> {item.feedback === "liked" ? "Liked" : "Like"}
            </button>
            <button
              type="button"
              aria-label={`Save ${item.title}`}
              onClick={() => void onSave(item.id)}
              className={micro.btnSoft}
            >
              <Bookmark className="size-3.5" /> {item.feedback === "saved" ? "Saved" : "Save"}
            </button>
            <button
              type="button"
              aria-label={`Not relevant: ${item.title}`}
              onClick={() => void onReject(item.id)}
              className={micro.btnSoft}
            >
              <ThumbsDown className="size-3.5" />
            </button>
            <button type="button" onClick={() => onAskAgent(item)} className={micro.btnSoft}>
              <MessageCircle className="size-3.5" /> Ask Agent
            </button>
            <button type="button" onClick={() => onCreateDraft(item)} className={micro.btnPrimary}>
              Create draft
            </button>
            {item.sourceUrl && (
              <a
                href={item.sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                aria-label="Open original source"
                className={micro.btnOutline}
              >
                Source <ExternalLink className="size-3.5" />
              </a>
            )}
          </div>
        </div>
      </MicroAppPanel>
    </article>
  );
}

function StatsLine({ item }: { item: DiscoverRecommendation }) {
  const stats = visibleStats(item);
  if (!stats.length) return null;
  return (
    <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-semibold text-[#17213a]/45">
      {stats.slice(0, 3).map(([label, value]) => (
        <span key={label}>
          {formatStat(value)} {label.toLowerCase()}
        </span>
      ))}
    </p>
  );
}

function PostDetailsDialog({
  item,
  onClose,
}: {
  item: DiscoverRecommendation | null;
  onClose: () => void;
}) {
  const stats = item ? visibleStats(item) : [];
  return (
    <Dialog open={Boolean(item)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] w-[calc(100vw-1.5rem)] max-w-2xl overflow-y-auto rounded-[20px] p-0 sm:rounded-[24px]">
        {item && (
          <>
            {item.thumbnailUrl && (
              <DecodedImage
                src={item.thumbnailUrl}
                alt=""
                className="max-h-80 w-full rounded-t-[24px] object-cover"
              />
            )}
            <div className="p-5 sm:p-7">
              <DialogHeader>
                <p className={micro.eyebrowMuted}>
                  {item.platform || item.sourceName || "Public source"}
                  {item.author ? ` · ${item.author}` : ""}
                </p>
                <DialogTitle className="mt-2 break-words text-left font-ui-display text-2xl leading-tight text-[#17213a] sm:text-3xl">
                  {item.title}
                </DialogTitle>
                <DialogDescription className="text-left">
                  {item.sourceName || "Public post"}
                  {item.sourcePublishedAt
                    ? ` · ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(item.sourcePublishedAt))}`
                    : ""}
                </DialogDescription>
              </DialogHeader>

              {stats.length > 0 && (
                <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {stats.map(([label, value]) => (
                    <div key={label} className="rounded-2xl bg-[#f2f5fb] p-4">
                      <p className="text-xl font-semibold text-[#17213a]">{formatStat(value)}</p>
                      <p className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-[#17213a]/40">
                        {label}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {item.summary && (
                <p className="mt-6 whitespace-pre-wrap text-sm leading-7 text-[#17213a]/68">
                  {item.summary}
                </p>
              )}
              <p className="mt-5 rounded-2xl border border-[#3478f6]/15 bg-[#eef5ff] p-4 text-sm leading-6 text-[#17213a]/62">
                {item.reason}
              </p>
              {item.sourceUrl && (
                <a
                  href={item.sourceUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className={`${micro.btnPrimary} mt-6`}
                >
                  Open original post <ExternalLink className="size-4" />
                </a>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function visibleStats(item: DiscoverRecommendation) {
  const stats = item.stats || {};
  return [
    ["Views", stats.views],
    ["Likes", stats.likes],
    ["Comments", stats.comments],
    ["Shares", stats.shares],
    ["Saves", stats.saves],
    ["Engagement rate", stats.engagementRate],
  ].filter((entry): entry is [string, number] => typeof entry[1] === "number");
}

function formatStat(value: number) {
  if (value > 0 && value <= 1) return `${Math.round(value * 100)}%`;
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

function Empty({ message }: { message: string }) {
  return <div className={`${micro.empty} mt-5`}>{message}</div>;
}

function recommendationMatches(item: DiscoverRecommendation, query: string) {
  if (!query) return true;
  return `${item.title} ${item.summary || ""} ${item.reason} ${item.sourceName || ""} ${item.angles.join(" ")}`
    .toLowerCase()
    .includes(query);
}

function relativePublishedAt(value: string, now: Date) {
  const elapsed = now.getTime() - Date.parse(value);
  const hours = Math.max(0, Math.floor(elapsed / (60 * 60 * 1_000)));
  if (hours < 1) return "Now";
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
