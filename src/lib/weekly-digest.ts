import { emailDailyCap, weeklyDigestSendCap } from "./email-daily-cap";
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

export function shouldEnqueueWeeklyDigest(now: Date) {
  return now.getUTCDay() === 1;
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
  options: { now: Date; cap: number; existingEventKeys?: Iterable<string> },
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
    const eventKey = weeklyDigestEventKey(group.authUserId, weekStart);
    if (existing.has(eventKey)) continue;
    drafts.push({
      eventKey,
      authUserId: group.authUserId,
      email: group.email,
      recipientName: group.recipientName,
      views: pageList.reduce((sum, page) => sum + page.views, 0),
      clicks: pageList.reduce((sum, page) => sum + page.clicks, 0),
      sales: group.sales,
      pages: pageList,
    });
  }

  drafts.sort((left, right) => right.views - left.views || left.email.localeCompare(right.email));
  return drafts.slice(0, cap);
}

export function configuredWeeklyDigestCap() {
  return weeklyDigestSendCap(undefined, emailDailyCap("marketing"));
}
