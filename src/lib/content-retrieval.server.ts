import { ProviderBudgetError } from "./provider-budget.server";
/** Retry transient provider failures once, with a deadline shared by every attempt. */
export class ContentRetrievalError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export const retryableContentStatus = (status: number) =>
  [408, 429, 500, 502, 503, 504].includes(status);

export async function retryContentRequest<T>(
  request: (signal: AbortSignal) => Promise<T>,
  options: { timeoutMs?: number; signal?: AbortSignal; delay?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = AbortSignal.any([
    AbortSignal.timeout(timeoutMs * 2 + 500),
    ...(options.signal ? [options.signal] : []),
  ]);
  let previousFailure: unknown;
  for (let attempt = 0; ; attempt++) {
    deadline.throwIfAborted();
    try {
      const signal = AbortSignal.any([deadline, AbortSignal.timeout(timeoutMs)]);
      let rejectOnAbort: () => void = () => {};
      const cancelled = new Promise<never>((_, reject) => {
        rejectOnAbort = () => reject(signal.reason);
        signal.addEventListener("abort", rejectOnAbort, { once: true });
      });
      try {
        // Bound callbacks such as budget reservations too, even if they ignore fetch signals.
        return await Promise.race([cancelled, request(signal)]);
      } finally {
        signal.removeEventListener("abort", rejectOnAbort);
      }
    } catch (error) {
      if (
        error instanceof ContentRetrievalError &&
        /budget/i.test(error.message) &&
        previousFailure instanceof Error
      )
        throw new ContentRetrievalError(
          `${error.message} Previous attempt: ${previousFailure.message.slice(0, 200)}`,
          false,
        );
      if (
        error instanceof ProviderBudgetError ||
        attempt >= 1 ||
        deadline.aborted ||
        (error instanceof ContentRetrievalError && !error.retryable)
      )
        throw error;
      previousFailure = error;
      await (options.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(250);
    }
  }
}
