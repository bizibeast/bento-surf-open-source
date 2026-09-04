import { z } from "zod";

export const EXPLORE_CATEGORIES = [
  {
    id: "creator",
    label: "Creators",
    choiceLabel: "Creator",
    description: "Content, videos, podcasts, and personal brands",
  },
  {
    id: "designer",
    label: "Designers",
    choiceLabel: "Designer",
    description: "Brand, product, graphic, and visual design",
  },
  {
    id: "developer",
    label: "Developers",
    choiceLabel: "Developer",
    description: "Software, apps, open source, and technical work",
  },
  {
    id: "artist",
    label: "Artists",
    choiceLabel: "Artist",
    description: "Illustration, music, craft, and original art",
  },
  {
    id: "photographer",
    label: "Photographers",
    choiceLabel: "Photographer",
    description: "Photography, film, and visual stories",
  },
  {
    id: "founder",
    label: "Founders",
    choiceLabel: "Founder",
    description: "Startups, products, and independent businesses",
  },
  {
    id: "business",
    label: "Businesses",
    choiceLabel: "Business",
    description: "Studios, teams, shops, and organizations",
  },
  {
    id: "marketer",
    label: "Marketers",
    choiceLabel: "Marketer",
    description: "Growth, social, brand, and audience strategy",
  },
  {
    id: "educator",
    label: "Coaches & educators",
    choiceLabel: "Coach or educator",
    description: "Teaching, coaching, courses, and communities",
  },
] as const;

export const EXPLORE_CATEGORY_IDS = EXPLORE_CATEGORIES.map((category) => category.id);

export type ExploreCategory = (typeof EXPLORE_CATEGORIES)[number]["id"];

export const exploreCategorySchema = z.enum(
  EXPLORE_CATEGORY_IDS as [ExploreCategory, ...ExploreCategory[]],
);

export function exploreCategoryLabel(value: string) {
  return EXPLORE_CATEGORIES.find((category) => category.id === value)?.choiceLabel ?? "Creator";
}

export function normalizeExploreSearch(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[^a-z0-9 _-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
}

export function explorePreviewUrl(username: string, version?: string) {
  const path = `/api/og/${encodeURIComponent(username)}.jpg`;
  return version ? `${path}?v=${encodeURIComponent(version)}` : path;
}

export const EXPLORE_REVIEW_MIN_CARDS = 3;

export const EXPLORE_REVIEW_STATUSES = ["none", "pending", "approved", "rejected"] as const;
export const EXPLORE_REVIEW_QUEUES = ["pending", "live", "rejected"] as const;

export type ExploreReviewStatus = (typeof EXPLORE_REVIEW_STATUSES)[number];
export type ExploreReviewQueue = (typeof EXPLORE_REVIEW_QUEUES)[number];

export const exploreReviewStatusSchema = z.enum(EXPLORE_REVIEW_STATUSES);
export const exploreReviewQueueSchema = z.enum(EXPLORE_REVIEW_QUEUES);

export function isReadyForExploreReview(cardCount: number) {
  return Number.isFinite(cardCount) && cardCount > EXPLORE_REVIEW_MIN_CARDS;
}

export function nextExploreReviewState(input: {
  showInExplore: boolean;
  wasOptedIn: boolean;
  status: ExploreReviewStatus;
  cardCount: number;
  optedInAt: string | null;
  now: string;
}): {
  status: ExploreReviewStatus;
  optedInAt: string | null;
  clearReview: boolean;
} {
  const ready = isReadyForExploreReview(input.cardCount);
  const justOptedIn = input.showInExplore && !input.wasOptedIn;

  if (!input.showInExplore) {
    if (input.status === "approved") {
      return { status: "approved", optedInAt: input.optedInAt, clearReview: false };
    }
    return { status: "none", optedInAt: null, clearReview: true };
  }

  if (input.status === "approved") {
    return { status: "approved", optedInAt: input.optedInAt, clearReview: false };
  }

  if (justOptedIn) {
    if (ready) {
      return { status: "pending", optedInAt: input.now, clearReview: true };
    }
    return { status: "none", optedInAt: null, clearReview: true };
  }

  if (input.status === "rejected") {
    return { status: "rejected", optedInAt: input.optedInAt, clearReview: false };
  }

  if (ready) {
    if (input.status === "pending") {
      return { status: "pending", optedInAt: input.optedInAt, clearReview: false };
    }
    return { status: "pending", optedInAt: input.now, clearReview: false };
  }

  return { status: "none", optedInAt: null, clearReview: false };
}

export function exploreReviewStatusAfterOptIn(
  current: ExploreReviewStatus | null | undefined,
  cardCount: number,
): ExploreReviewStatus {
  return nextExploreReviewState({
    showInExplore: true,
    wasOptedIn: false,
    status: current ?? "none",
    cardCount,
    optedInAt: null,
    now: "now",
  }).status;
}

export function isLiveOnExplore(profile: {
  show_in_explore: boolean;
  explore_review_status: string;
  onboarded?: boolean;
  noindex?: boolean;
  cardCount?: number;
}) {
  return (
    profile.show_in_explore &&
    profile.explore_review_status === "approved" &&
    profile.onboarded !== false &&
    profile.noindex !== true &&
    (profile.cardCount == null || isReadyForExploreReview(profile.cardCount))
  );
}

function exploreReviewSortTime(
  row: {
    explore_opted_in_at: string | null;
    explore_reviewed_at: string | null;
    updated_at?: string | null;
  },
  queue: ExploreReviewQueue,
) {
  const primary = queue === "pending" ? row.explore_opted_in_at : row.explore_reviewed_at;
  const raw = primary ?? row.updated_at ?? null;
  const time = raw ? Date.parse(raw) : 0;
  return Number.isFinite(time) ? time : 0;
}

/** Newest first. Pending uses opt-in time; decided queues use review time. */
export function sortExploreReviewsNewestFirst<
  T extends {
    username: string;
    explore_opted_in_at: string | null;
    explore_reviewed_at: string | null;
    updated_at?: string | null;
  },
>(rows: T[], queue: ExploreReviewQueue): T[] {
  return [...rows].sort((left, right) => {
    const delta = exploreReviewSortTime(right, queue) - exploreReviewSortTime(left, queue);
    if (delta !== 0) return delta;
    return left.username.localeCompare(right.username);
  });
}

export function exploreOptInStatusCopy(
  optedIn: boolean,
  status: ExploreReviewStatus | null | undefined,
  cardCount?: number,
) {
  if (!optedIn) {
    return "Turn this on to be considered for Explore. Pages with more than 3 cards are sent for review.";
  }
  const ready = cardCount == null || isReadyForExploreReview(cardCount);
  if (status === "approved") {
    if (!ready) return "Approved. Add more than 3 cards for it to appear on Explore.";
    return "Your Surf is live on Explore.";
  }
  if (status === "rejected") {
    return "This Surf was not approved. Turn this off and on to submit it again after you have more than 3 cards.";
  }
  if (status === "pending") return "Submitted for review. Newest requests are reviewed first.";
  return "Once your Surf has more than 3 cards, it will be sent for Explore review.";
}
