import { Sparkles } from "lucide-react";
import "./discover.css";

export function DiscoverLoading({
  status = "Finding fresh inspiration for you…",
  compact = false,
  count = 6,
}: {
  status?: string;
  compact?: boolean;
  count?: number;
}) {
  return (
    <div className="discover-loading" aria-busy="true">
      <div
        className={`discover-progress${compact ? " discover-progress-compact" : ""}`}
        role="status"
        aria-live="polite"
      >
        <span className="discover-progress-orbit" aria-hidden="true">
          <Sparkles />
        </span>
        <div>
          <strong>{status}</strong>
          {!compact && (
            <p>
              Checking relevance, recency and reported performance before posts reach your board.
            </p>
          )}
        </div>
      </div>
      <div className="discover-skeleton-grid" aria-hidden="true">
        <DiscoverSkeletonCards count={count} />
      </div>
    </div>
  );
}

export function DiscoverSkeletonCards({ count = 3 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => {
        const variant = ["portrait", "text", "landscape", "text-long", "square", "landscape"][
          index % 6
        ];
        const textFirst = variant.startsWith("text");
        return (
          <div
            className="discover-skeleton-card"
            data-variant={variant}
            aria-hidden="true"
            key={index}
            style={{ animationDelay: `${index * 55}ms` }}
          >
            {!textFirst && <div className="discover-skeleton-image" />}
            <div className="discover-skeleton-identity">
              <span />
              <div>
                <i />
                <i />
              </div>
            </div>
            <div className="discover-skeleton-line" />
            <div className="discover-skeleton-line discover-skeleton-short" />
            {textFirst && (
              <div className="discover-skeleton-text">
                {Array.from({ length: variant === "text-long" ? 6 : 3 }, (_, line) => (
                  <div className="discover-skeleton-line" key={line} />
                ))}
              </div>
            )}
            <div className="discover-skeleton-metrics">
              <span />
              <span />
              <span />
            </div>
          </div>
        );
      })}
    </>
  );
}
