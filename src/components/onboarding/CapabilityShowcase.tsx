import { useEffect, useRef } from "react";
import { ArrowRight, BookOpen, CalendarClock, Lightbulb, PenLine, ShoppingBag } from "lucide-react";
import { captureProductEvent } from "@/lib/posthog";
import { planAvailabilityLabel, showcaseItems } from "@/lib/onboarding/showcase";

const icons = {
  brain: BookOpen,
  sell: ShoppingBag,
  post: CalendarClock,
  ideas: Lightbulb,
  ai: PenLine,
} as const;

export function CapabilityShowcase({
  brainChapters,
  onContinue,
  onSkip,
}: {
  brainChapters: number;
  onContinue: () => void;
  onSkip: () => void;
}) {
  const items = showcaseItems(brainChapters);
  const viewed = useRef(false);
  const shownAt = useRef(0);
  useEffect(() => {
    if (viewed.current) return;
    viewed.current = true;
    shownAt.current = Date.now();
    captureProductEvent("onboarding_showcase_viewed", {
      items: items.length,
      brain_chapters: brainChapters,
    });
    // Viewed once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const seconds = () => Math.round((Date.now() - shownAt.current) / 1000);
  return (
    <div className="ob-showcase" data-testid="capability-showcase">
      <ul className="ob-showcase-grid">
        {items.map((item) => {
          const Icon = icons[item.id];
          return (
            <li key={item.id} className={`ob-showcase-card ob-showcase-${item.id}`}>
              <span className="ob-showcase-icon" aria-hidden="true">
                <Icon />
              </span>
              <span className="ob-showcase-copy">
                <strong>{item.title}</strong>
                <span>{item.body}</span>
                <small>{planAvailabilityLabel(item.entitlement)}</small>
              </span>
            </li>
          );
        })}
      </ul>
      <p className="ob-center-note ob-showcase-note">
        Your trial includes only the plan you pick, so it includes only the tools labeled for that
        plan. Card, UPI or wallet required. No charge if you cancel before the trial ends.
      </p>
      <div className="ob-ready-actions ob-showcase-actions">
        <button
          className="ob-primary"
          type="button"
          onClick={() => {
            captureProductEvent("onboarding_showcase_completed", { seconds: seconds() });
            onContinue();
          }}
        >
          Choose my plan <ArrowRight />
        </button>
        <button
          className="ob-text-link"
          type="button"
          onClick={() => {
            captureProductEvent("onboarding_showcase_skipped", { seconds: seconds() });
            onSkip();
          }}
        >
          Skip
        </button>
      </div>
    </div>
  );
}
