import { weeklyDigestDailyCap } from "./email-daily-cap";
import { isDisposableOrTestEmail } from "./disposable-email";
import { normalizeEmailRecipient } from "./email-recipient";

export type WeeklyDigestPage = {
  authUserId: string;
  email: string;
  recipientName: string | null;
  workspaceId: string;
  username: string;
  views: number;
  clicks: number;
  sales: number;
};

export type WeeklyDigestPageSummary = {
  username: string;
  views: number;
  clicks: number;
};

export type WeeklyDigestDraft = {
  eventKey: string;
  cohort: number;
  authUserId: string;
  email: string;
  recipientName: string | null;
  views: number;
  clicks: number;
  sales: number;
  pages: WeeklyDigestPageSummary[];
};

export function utcIsoWeekStart(now: Date) {
  const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() - day + 1);
  return utc.toISOString().slice(0, 10);
}

export function utcDateDaysAgo(now: Date, days: number) {
  const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  utc.setUTCDate(utc.getUTCDate() - days);
  return utc.toISOString().slice(0, 10);
}

/** Monday is 0, Sunday is 6 (UTC, the same day Resend's quota uses). */
export function utcIsoWeekdayIndex(now: Date) {
  return (now.getUTCDay() + 6) % 7;
}

/**
 * Two send days per week. Each person lands in the same cohort every week:
 * cohort 0 on Monday, cohort 1 on Tuesday. FNV-1a keeps the split stable
 * across deploys and runtimes.
 */
export const WEEKLY_DIGEST_COHORTS = 2;

export function weeklyDigestCohort(authUserId: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < authUserId.length; index += 1) {
    hash ^= authUserId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Use the high bits: FNV-1a's lowest bit is only the parity of the input bytes.
  return Math.floor((hash / 0x1_0000_0000) * WEEKLY_DIGEST_COHORTS);
}

/**
 * Cohorts whose send day has arrived this ISO week. Later days still include
 * earlier cohorts so anyone held back by the daily cap rolls over to the
 * next day until Sunday. The event key stops a second copy in the same week.
 */
export function dueWeeklyDigestCohorts(now: Date) {
  const weekday = utcIsoWeekdayIndex(now);
  return Array.from({ length: WEEKLY_DIGEST_COHORTS }, (_, cohort) => cohort).filter(
    (cohort) => cohort <= weekday,
  );
}

export function shouldEnqueueWeeklyDigest(now: Date) {
  return dueWeeklyDigestCohorts(now).length > 0;
}

/** The ISO week start (YYYY-MM-DD) stored at the end of a digest event key. */
export function weeklyDigestWeekFromEventKey(eventKey: string) {
  const match = /^weekly-digest:.+:(\d{4}-\d{2}-\d{2})$/.exec(eventKey);
  return match?.[1] ?? null;
}

/** A digest that could not go out in its own week is dropped, never sent late. */
export function weeklyDigestExpired(eventKey: string, now: Date) {
  const week = weeklyDigestWeekFromEventKey(eventKey);
  return week !== null && week < utcIsoWeekStart(now);
}

export function weeklyDigestEventKey(authUserId: string, weekStart: string) {
  return `weekly-digest:${authUserId}:${weekStart}`;
}

function count(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

type Group = {
  authUserId: string;
  email: string;
  recipientName: string | null;
  sales: number;
  pages: Map<string, WeeklyDigestPageSummary>;
};

/**
 * One digest per inbox per ISO week. Pages with no visits are omitted.
 * The whole user is omitted when every page had 0 visits.
 * `existingEventKeys` are already stored on email_outbox, so a retry
 * does not consume the run cap with duplicates.
 */
export function selectWeeklyDigests(
  pages: WeeklyDigestPage[],
  options: {
    now: Date;
    cap: number;
    existingEventKeys?: Iterable<string>;
    /** Only these cohorts. Defaults to every cohort. */
    cohorts?: number[];
  },
) {
  const cap = Number.isFinite(options.cap) ? Math.max(0, Math.floor(options.cap)) : 0;
  if (!cap) return [];
  const existing = new Set(options.existingEventKeys ?? []);
  const weekStart = utcIsoWeekStart(options.now);
  const groups = new Map<string, Group>();

  for (const page of pages) {
    const email = normalizeEmailRecipient(page.email);
    const authUserId = page.authUserId.trim();
    const username = page.username.trim();
    if (!email || !authUserId || !username || isDisposableOrTestEmail(email)) continue;
    const views = count(page.views);
    const clicks = count(page.clicks);
    const sales = count(page.sales);
    if (!views && !sales) continue;
    let group = groups.get(email);
    if (!group) {
      group = {
        authUserId,
        email,
        recipientName: page.recipientName?.trim() || null,
        sales: 0,
        pages: new Map(),
      };
      groups.set(email, group);
    } else if (authUserId < group.authUserId) {
      group.authUserId = authUserId;
    }
    if (!group.recipientName && page.recipientName?.trim()) {
      group.recipientName = page.recipientName.trim();
    }
    group.sales += sales;
    if (!views) continue;
    const current = group.pages.get(page.workspaceId) ?? { username, views: 0, clicks: 0 };
    current.username = username;
    current.views += views;
    current.clicks += clicks;
    group.pages.set(page.workspaceId, current);
  }

  const drafts: WeeklyDigestDraft[] = [];
  for (const group of groups.values()) {
    const pageList = [...group.pages.values()].sort(
      (left, right) => right.views - left.views || left.username.localeCompare(right.username),
    );
    if (!pageList.length) continue;
    const cohort = weeklyDigestCohort(group.authUserId);
    if (options.cohorts && !options.cohorts.includes(cohort)) continue;
    const eventKey = weeklyDigestEventKey(group.authUserId, weekStart);
    if (existing.has(eventKey)) continue;
    drafts.push({
      eventKey,
      cohort,
      authUserId: group.authUserId,
      email: group.email,
      recipientName: group.recipientName,
      views: pageList.reduce((sum, page) => sum + page.views, 0),
      clicks: pageList.reduce((sum, page) => sum + page.clicks, 0),
      sales: group.sales,
      pages: pageList,
    });
  }

  // Earlier cohorts first, so a held-back Monday recipient goes before Tuesday's.
  drafts.sort(
    (left, right) =>
      left.cohort - right.cohort ||
      right.views - left.views ||
      left.email.localeCompare(right.email),
  );
  return drafts.slice(0, cap);
}

export function configuredWeeklyDigestCap() {
  return weeklyDigestDailyCap();
}
