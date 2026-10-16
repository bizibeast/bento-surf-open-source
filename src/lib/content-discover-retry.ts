export const DISCOVER_AUTOMATIC_RETRIES = 2;
export const DISCOVER_BUSY_RETRIES = 8;

const busyRefreshMessage = "Discover refresh is already running. Retrying shortly.";

// Error messages survive the server-function boundary even when custom error fields do not.
const recoverableRefreshMessages = new Set([
  busyRefreshMessage,
  "Discover refresh could not start. Retrying shortly.",
  "Discover refresh was interrupted. Retrying shortly.",
  "The refresh was interrupted. Your current feed is safe. Please try again.",
]);

export function isDiscoverRefreshBusy(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: string; message?: string; status?: number; statusCode?: number };
  const status = value.status ?? value.statusCode;
  return (
    value.name !== "AbortError" &&
    value.message === busyRefreshMessage &&
    (status === undefined || (status >= 500 && status <= 599))
  );
}

/** Only retry temporary transport/provider failures, never permissions or user input. */
export function isTransientDiscoverError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: string; message?: string; status?: number; statusCode?: number };
  if (value.name === "AbortError") return false;
  const message = value.message || "";
  if (
    /unauthori[sz]ed|forbidden|sign[ -]?in|log[ -]?in|permission|invalid|validation|rate.?limit|too many requests|quota|not configured|api key/i.test(
      message,
    )
  ) {
    return false;
  }
  const status = value.status ?? value.statusCode;
  if (status !== undefined) return status === 408 || (status >= 500 && status <= 599);
  if (value.name === "TimeoutError") return true;
  if (recoverableRefreshMessages.has(message)) return true;
  return /timeout|timed out|network|failed to fetch|fetch failed|load failed|connection|temporar(?:y|ily)|unavailable|upstream|research could not finish|\b(?:408|50[0234]|52[0-4])\b/i.test(
    message,
  );
}

export function shouldRetryDiscover(failureCount: number, error: unknown): boolean {
  const limit = isDiscoverRefreshBusy(error) ? DISCOVER_BUSY_RETRIES : DISCOVER_AUTOMATIC_RETRIES;
  return failureCount < limit && isTransientDiscoverError(error);
}

export function discoverRetryDelay(attempt: number, error?: unknown): number {
  // A cancelled browser request may still hold its server lease. Allow its bounded
  // work (or the 120-second lease expiry) to finish without starting parallel research.
  if (isDiscoverRefreshBusy(error)) return 15_000 * (1 + Math.random() * 0.2);
  return Math.min(8_000, 2_000 * 2 ** attempt) * (0.8 + Math.random() * 0.4);
}

/** Abort the actual server-function fetch as well as bounding the UI's wait. */
export async function withDiscoverDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () =>
    controller.abort(parentSignal?.reason ?? new DOMException("Cancelled", "AbortError"));
  if (parentSignal?.aborted) cancel();
  else parentSignal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException("Discover took too long to respond.", "TimeoutError")),
    timeoutMs,
  );
  let onAbort: (() => void) | undefined;
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", cancel);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
  }
}
