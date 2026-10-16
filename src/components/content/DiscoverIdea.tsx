import { ArrowUpRight, Bookmark, Check, Lightbulb, Sparkles, ThumbsDown } from "lucide-react";
import type { DiscoverRecommendation } from "@/lib/content-discovery.functions";
import { publicSourceUrl } from "@/lib/content-source-media";
import { CreatorIdentity, type DiscoverActions } from "./DiscoverPost";

/** A creation brief, with the original inspiration clearly separated below it. */
export function DiscoverIdeaCard({
  item,
  now,
  actions,
  onSource,
}: {
  item: DiscoverRecommendation;
  now: Date;
  actions: DiscoverActions;
  onSource?: (item: DiscoverRecommendation) => void;
}) {
  const inspiration = item.inspiration;
  const source = publicSourceUrl(item.sourceUrl);
  const saved = item.saved || item.feedback === "saved";
  return (
    <article aria-label={item.title} className="discover-card discover-idea-card">
      <div className="discover-idea-topline">
        <span>
          <Lightbulb /> Idea to make your own
        </span>
        <span>{inspiration?.format || "Your original take"}</span>
      </div>
      <div className="discover-idea-content">
        <h3>{item.title}</h3>
        {inspiration?.hook && (
          <div className="discover-idea-hook">
            <span>Opening hook</span>
            <p>{inspiration.hook}</p>
          </div>
        )}
        {inspiration && item.summary && <p className="discover-idea-thesis">{item.summary}</p>}
        <div className="discover-idea-outline">
          <h4>{inspiration?.outline.length ? "Build it like this" : "Angles to explore"}</h4>
          <ol>
            {(inspiration?.outline.length ? inspiration.outline : item.angles).map(
              (angle, index) => (
                <li key={`${index}:${angle}`}>{angle}</li>
              ),
            )}
          </ol>
        </div>
        {inspiration?.whyNow && (
          <p className="discover-idea-timing">
            <Sparkles aria-hidden="true" />
            {inspiration.whyNow}
          </p>
        )}
      </div>
      <div className="discover-idea-source">
        <span>Inspired by a real post</span>
        <CreatorIdentity item={item} now={now} />
        {source && (
          <a href={source} target="_blank" rel="noreferrer noopener">
            View inspiration <ArrowUpRight />
          </a>
        )}
        {onSource && (
          <button type="button" onClick={() => onSource(item)}>
            Source details
          </button>
        )}
      </div>
      <div className="discover-idea-actions">
        <button
          type="button"
          className="discover-idea-create"
          onClick={() => actions.onCreateDraft(item)}
        >
          <Sparkles />
          Create draft
        </button>
        <button type="button" onClick={() => actions.onAskAgent(item, "variations")}>
          Explore angles
        </button>
        <button
          type="button"
          className="discover-icon-button"
          aria-label={saved ? "Saved" : "Save idea"}
          disabled={actions.pending.has(item.id) || (saved && !actions.onUnsave)}
          onClick={() => (saved ? actions.onUnsave?.(item.id) : actions.onSave(item.id))}
        >
          {saved ? <Check /> : <Bookmark />}
        </button>
        <button
          type="button"
          className="discover-icon-button"
          aria-label="Less like this"
          disabled={actions.pending.has(item.id)}
          onClick={() => actions.onReject(item.id)}
        >
          <ThumbsDown />
        </button>
      </div>
    </article>
  );
}
