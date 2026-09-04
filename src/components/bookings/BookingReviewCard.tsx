import { LoaderCircle, Star } from "lucide-react";

export type BookingReviewSummary = {
  rating: number | null;
  body: string | null;
  reviewerName: string | null;
};

export function BookingReviewCard({
  review,
  visibility,
}: {
  review: BookingReviewSummary;
  visibility?: {
    isPublic: boolean;
    pending: boolean;
    onChange: (isPublic: boolean) => void;
  };
}) {
  const reviewerName = review.reviewerName || "Customer";
  const rating = Number(review.rating || 0);

  return (
    <article className="rounded-[22px] border border-border/70 bg-background/65 p-4">
      <div className="flex items-start justify-between gap-3">
        <div
          className="flex gap-0.5 text-amber-500"
          role="img"
          aria-label={`${rating} out of 5 stars`}
        >
          {Array.from({ length: 5 }, (_, index) => (
            <Star
              key={index}
              aria-hidden="true"
              className={`size-3.5 ${index < rating ? "fill-current" : "opacity-20"}`}
            />
          ))}
        </div>
        {visibility ? (
          <button
            type="button"
            role="switch"
            aria-checked={visibility.isPublic}
            aria-label={`Show review from ${reviewerName} on calendar page`}
            disabled={visibility.pending}
            onClick={() => visibility.onChange(!visibility.isPublic)}
            className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-[10px] font-semibold text-foreground disabled:opacity-50"
          >
            {visibility.pending ? <LoaderCircle className="size-3 animate-spin" /> : null}
            <span
              aria-hidden="true"
              className={`size-2 rounded-[3px] ${visibility.isPublic ? "bg-emerald-500" : "bg-muted-foreground/35"}`}
            />
            {visibility.isPublic ? "On calendar" : "Hidden"}
          </button>
        ) : null}
      </div>
      {review.body ? <p className="mt-3 text-sm leading-6">{review.body}</p> : null}
      <div className="mt-3 text-xs text-muted-foreground">{reviewerName}</div>
    </article>
  );
}
