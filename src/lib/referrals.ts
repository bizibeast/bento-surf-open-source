export const REFERRAL_COMMISSION_BPS = 2_000;
export const REFERRAL_PAYOUT_MINIMUM_USD = 5_000;
export const REFERRAL_REACH_CAP = 50_000;

const RESERVED_CODES = new Set([
  "admin",
  "api",
  "dashboard",
  "earn",
  "home",
  "login",
  "onboarding",
  "r",
  "settings",
  "signup",
]);

const REACH_RATE_PER_10K: Partial<Record<string, number>> = {
  twitter: 1_000,
  linkedin: 2_500,
  instagram: 500,
  threads: 500,
};

export function isReferralCode(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/.test(value) && !RESERVED_CODES.has(value);
}

export function commissionAmount(total: number, tax: number, rateBps: number): number {
  return Math.floor((Math.max(0, total - tax) * rateBps) / 10_000);
}

export function referralRefundReversal(
  commission: number,
  alreadyReversed: number,
  refund: number,
  paymentTotal: number,
): number {
  if (paymentTotal <= 0) return 0;
  const proportional = Math.floor((commission * Math.max(0, refund)) / paymentTotal);
  return Math.max(0, Math.min(commission - alreadyReversed, proportional));
}

export function reachRewardAmount(
  provider: string,
  views: number,
  rates: Partial<Record<string, number>> = REACH_RATE_PER_10K,
  cap = REFERRAL_REACH_CAP,
): number | null {
  const rate = rates[provider];
  if (!rate) return null;
  return Math.min(cap, Math.floor((Math.max(0, views) * rate) / 10_000));
}

const REACH_POST_PATTERNS: Partial<Record<string, { hosts: string[]; path: RegExp }>> = {
  twitter: { hosts: ["x.com", "twitter.com"], path: /^\/[A-Za-z0-9_]+\/status\/\d+/ },
  linkedin: { hosts: ["linkedin.com"], path: /^\/(?:posts\/|feed\/update\/)/ },
  instagram: { hosts: ["instagram.com"], path: /^\/(?:p|reel)\// },
  threads: { hosts: ["threads.net"], path: /^\/@[^/]+\/post\// },
};

export type ReachPostProvider = "twitter" | "linkedin" | "instagram" | "threads";

export function canonicalReachPostUrl(value: string, provider: string): string | null {
  try {
    const url = new URL(value);
    const rule = REACH_POST_PATTERNS[provider];
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (
      url.protocol !== "https:" ||
      !rule ||
      !rule.hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)) ||
      !rule.path.test(url.pathname)
    ) {
      return null;
    }
    url.hostname = host;
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString();
  } catch {
    return null;
  }
}

export function reachPostFromUrl(
  value: string,
): { provider: ReachPostProvider; canonicalUrl: string } | null {
  for (const provider of Object.keys(REACH_POST_PATTERNS) as ReachPostProvider[]) {
    const canonicalUrl = canonicalReachPostUrl(value, provider);
    if (canonicalUrl) return { provider, canonicalUrl };
  }
  return null;
}
