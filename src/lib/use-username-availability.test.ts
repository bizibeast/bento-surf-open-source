import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useUsernameAvailability } from "./use-username-availability";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("useUsernameAvailability", () => {
  it("treats an unchanged current username as available without a remote lookup", async () => {
    vi.useFakeTimers();
    const check = vi.fn();
    const { result } = renderHook(() => useUsernameAvailability(check, 350, "current_name"));

    act(() => result.current.setUsername("current_name"));
    await act(async () => vi.advanceTimersByTimeAsync(350));

    expect(result.current.available).toBe(true);
    expect(check).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("retries the same valid username after an error and clears the error immediately", async () => {
    vi.useFakeTimers();
    const retryResult = deferred<{ available: boolean }>();
    const check = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockReturnValueOnce(retryResult.promise);
    const { result } = renderHook(() => useUsernameAvailability(check, 350));

    act(() => result.current.setUsername("retry_name"));
    await act(async () => vi.advanceTimersByTimeAsync(350));
    expect(result.current.availabilityError).toBe(true);

    act(() => result.current.retry());
    expect(result.current.username).toBe("retry_name");
    expect(result.current.availabilityError).toBe(false);
    expect(result.current.available).toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(350));
    expect(check).toHaveBeenLastCalledWith("retry_name");
    await act(async () => retryResult.resolve({ available: true }));
    expect(result.current.available).toBe(true);
    vi.useRealTimers();
  });

  it("ignores a retry response after the username changes", async () => {
    vi.useFakeTimers();
    const retryResult = deferred<{ available: boolean }>();
    const currentResult = deferred<{ available: boolean }>();
    const check = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockReturnValueOnce(retryResult.promise)
      .mockReturnValueOnce(currentResult.promise);
    const { result } = renderHook(() => useUsernameAvailability(check, 350));

    act(() => result.current.setUsername("retry_name"));
    await act(async () => vi.advanceTimersByTimeAsync(350));
    act(() => result.current.retry());
    await act(async () => vi.advanceTimersByTimeAsync(350));
    act(() => result.current.setUsername("current_name"));
    await act(async () => vi.advanceTimersByTimeAsync(350));

    await act(async () => retryResult.resolve({ available: false }));
    expect(result.current.available).toBeNull();
    await act(async () => currentResult.resolve({ available: true }));
    expect(result.current.available).toBe(true);
    vi.useRealTimers();
  });

  it("resets a successful result immediately when the username is edited", async () => {
    vi.useFakeTimers();
    const check = vi.fn().mockResolvedValue({ available: true });
    const { result } = renderHook(() => useUsernameAvailability(check, 350));

    act(() => result.current.setUsername("first_name"));
    await act(async () => vi.advanceTimersByTimeAsync(350));
    expect(result.current.available).toBe(true);

    act(() => result.current.setUsername("second_name"));

    expect(result.current.available).toBeNull();
    vi.useRealTimers();
  });

  it("ignores an older response that arrives after the current response", async () => {
    vi.useFakeTimers();
    const first = deferred<{ available: boolean }>();
    const second = deferred<{ available: boolean }>();
    const check = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useUsernameAvailability(check, 350));

    act(() => result.current.setUsername("first_name"));
    await act(async () => vi.advanceTimersByTimeAsync(350));
    act(() => result.current.setUsername("second_name"));
    await act(async () => vi.advanceTimersByTimeAsync(350));

    await act(async () => second.resolve({ available: true }));
    expect(result.current.available).toBe(true);

    await act(async () => first.resolve({ available: false }));
    expect(result.current.available).toBe(true);
    vi.useRealTimers();
  });

  it("ignores a stale failure and exposes only a current lookup failure", async () => {
    vi.useFakeTimers();
    const first = deferred<{ available: boolean }>();
    const second = deferred<{ available: boolean }>();
    const check = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useUsernameAvailability(check, 350));

    act(() => result.current.setUsername("first_name"));
    await act(async () => vi.advanceTimersByTimeAsync(350));
    act(() => result.current.setUsername("second_name"));
    await act(async () => vi.advanceTimersByTimeAsync(350));
    await act(async () => first.reject(new Error("stale backend detail")));
    expect(result.current.availabilityError).toBe(false);

    await act(async () => second.reject(new Error("current failure")));
    expect(result.current.available).toBeNull();
    expect(result.current.availabilityError).toBe(true);
    vi.useRealTimers();
  });
});
