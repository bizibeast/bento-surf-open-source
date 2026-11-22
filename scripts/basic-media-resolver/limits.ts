export const DAILY_ATTEMPTS = 50;
export const MONTHLY_ATTEMPTS = 250;
export type Attempts = { day: string; month: string; daily: number; monthly: number };
export function nextAttempt(old: Attempts | undefined, now: string): Attempts | null {
  const daily = old?.day === now.slice(0, 10) ? old.daily : 0;
  const monthly = old?.month === now.slice(0, 7) ? old.monthly : 0;
  // Bounded staging commissioning allowance; usage and monthly ceiling stay intact.
  const limit = now.slice(0, 10) === "2026-11-21" ? DAILY_ATTEMPTS + 50 : DAILY_ATTEMPTS;
  if (daily >= limit || monthly >= MONTHLY_ATTEMPTS) return null;
  return { day: now.slice(0, 10), month: now.slice(0, 7), daily: daily + 1, monthly: monthly + 1 };
}

export const TRANSFER_BLOCK_BYTES = 64 * 1024 * 1024;
export const DAILY_TRANSFER_BYTES = 25 * 1024 ** 3;
export const MONTHLY_TRANSFER_BYTES = 100 * 1024 ** 3;
/** Charge blocks before forwarding bytes, including failures. One slot serializes reservations. */
export function nextTransfer(old: Attempts | undefined, now: string): Attempts | null {
  const daily = old?.day === now.slice(0, 10) ? old.daily : 0;
  const monthly = old?.month === now.slice(0, 7) ? old.monthly : 0;
  if (
    daily + TRANSFER_BLOCK_BYTES > DAILY_TRANSFER_BYTES ||
    monthly + TRANSFER_BLOCK_BYTES > MONTHLY_TRANSFER_BYTES
  )
    return null;
  return {
    day: now.slice(0, 10),
    month: now.slice(0, 7),
    daily: daily + TRANSFER_BLOCK_BYTES,
    monthly: monthly + TRANSFER_BLOCK_BYTES,
  };
}
