import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverRetryDelay,
  isDiscoverRefreshBusy,
  isTransientDiscoverError,
  shouldRetryDiscover,
  withDiscoverDeadline,
} from "./content-discover-retry";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Discover transport recovery", () => {
  it.each([
    new TypeError("Failed to fetch"),
    new Error("Network request failed"),
    new DOMException("Slow request", "TimeoutError"),
    Object.assign(new Error("Unavailable"), { status: 503 }),
    new Error("Research could not finish. A source timed out."),
    new Error("Discover refresh could not start. Retrying shortly."),
    new Error("Discover refresh was interrupted. Retrying shortly."),
    new Error("The refresh was interrupted. Your current feed is safe. Please try again."),
  ])("retries temporary failure %s at most twice", (error) => {
    expect(shouldRetryDiscover(0, error)).toBe(true);
    expect(shouldRetryDiscover(1, error)).toBe(true);
    expect(shouldRetryDiscover(2, error)).toBe(false);
  });

  it.each([
    new Error("Discover refresh is already running. Retrying shortly."),
    { message: "Discover refresh is already running. Retrying shortly." },
  ])("allows eight spaced checks only for a busy server refresh", (error) => {
    expect(isDiscoverRefreshBusy(error)).toBe(true);
    expect(shouldRetryDiscover(7, error)).toBe(true);
    expect(shouldRetryDiscover(8, error)).toBe(false);
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(discoverRetryDelay(0, error)).toBe(15_000);
    expect(discoverRetryDelay(7, error)).toBe(15_000);
    vi.mocked(Math.random).mockReturnValue(1);
    expect(discoverRetryDelay(0, error)).toBe(18_000);
  });

  it.each([
    new DOMException("Cancelled", "AbortError"),
    Object.assign(new Error("Unavailable"), { status: 401 }),
    Object.assign(new Error("Unavailable"), { status: 403 }),
    Object.assign(new Error("Unavailable"), { status: 429 }),
    new Error("Too many requests. Try again later."),
    new Error("Invalid profile"),
    new Error("Service API key not configured"),
    Object.assign(new Error("Service API key not configured"), { status: 503 }),
    new TypeError("Cannot read properties of undefined"),
  ])("does not restart permanent failure or cancellation %s", (error) => {
    expect(isTransientDiscoverError(error)).toBe(false);
  });

  it("backs off with bounded jitter", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(discoverRetryDelay(0)).toBe(2_000);
    expect(discoverRetryDelay(1)).toBe(4_000);
    expect(discoverRetryDelay(10)).toBe(8_000);
  });

  it("times out an unresponsive operation and aborts its fetch signal", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const request = withDiscoverDeadline((value) => {
      signal = value;
      return new Promise<never>(() => undefined);
    }, 75_000);
    const rejection = expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(75_000);
    await rejection;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels immediately when the caller aborts and cleans up the deadline", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const operation = vi.fn(() => new Promise<never>(() => undefined));
    const request = withDiscoverDeadline(operation, 75_000, controller.signal);
    const rejection = expect(request).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejection;
    expect(operation.mock.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start an operation after its caller has already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const operation = vi.fn();
    await expect(withDiscoverDeadline(operation, 1_000, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(operation).not.toHaveBeenCalled();
  });
});
