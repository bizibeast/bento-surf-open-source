const DAY_MS = 86_400_000;

/** Missing or implausible dates remain unknown; retrieval time is never publication time. */
export function sourcePublicationTime(publishedAt: string | null | undefined, now: number) {
  if (!publishedAt) return null;
  const timestamp = Date.parse(publishedAt);
  return Number.isFinite(timestamp) && timestamp <= now + 5 * 60_000 ? timestamp : null;
}

export function sourcePublishedWithin(
  publishedAt: string | null | undefined,
  now: number,
  days = 30,
) {
  const timestamp = sourcePublicationTime(publishedAt, now);
  return timestamp !== null && timestamp >= now - days * DAY_MS;
}

/** Fresh this week, recent this month, undated, then archived. */
export function sourceFreshnessTier(publishedAt: string | null | undefined, now: number) {
  const timestamp = sourcePublicationTime(publishedAt, now);
  if (timestamp === null) return 1;
  return sourcePublishedWithin(publishedAt, now, 7)
    ? 3
    : sourcePublishedWithin(publishedAt, now, 30)
      ? 2
      : 0;
}
