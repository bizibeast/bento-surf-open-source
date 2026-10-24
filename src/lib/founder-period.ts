const DAY_MS = 86_400_000;

/** Date-only invoices include the current partial day, but never the next period. */
export function founderInvoiceEndDayExclusive(periodEnd: string) {
  return new Date(Math.ceil(Date.parse(periodEnd) / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}

/** One UTC calendar window shared by SQL, PostHog, charts and date labels. */
export function founderPeriod(days: number, offset = 0, now = new Date()) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startMs = today - (offset + days - 1) * DAY_MS;
  const endMs = offset === 0 ? now.getTime() : today - (offset - 1) * DAY_MS;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    dates: Array.from({ length: days }, (_, index) =>
      new Date(startMs + index * DAY_MS).toISOString().slice(0, 10),
    ),
  };
}
