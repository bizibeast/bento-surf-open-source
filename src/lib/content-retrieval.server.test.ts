import { expect, it, vi } from "vitest";
import { ContentRetrievalError, retryContentRequest } from "./content-retrieval.server";

it("retries an unresponsive provider once and bounds both attempts even if it ignores cancellation", async () => {
  const request = vi.fn(() => new Promise<never>(() => {}));
  await expect(
    retryContentRequest(request, { timeoutMs: 10, delay: async () => {} }),
  ).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(2);
});

it("does not restart work after the shared refresh deadline", async () => {
  const controller = new AbortController();
  const request = vi.fn(() => {
    controller.abort(new Error("Refresh deadline"));
    return new Promise<never>(() => {});
  });
  await expect(retryContentRequest(request, { signal: controller.signal })).rejects.toThrow(
    "Refresh deadline",
  );
  expect(request).toHaveBeenCalledTimes(1);
});

it("never retries a permanent error", async () => {
  const request = vi.fn().mockRejectedValue(new ContentRetrievalError("Not authorized", false));
  await expect(retryContentRequest(request)).rejects.toThrow("Not authorized");
  expect(request).toHaveBeenCalledTimes(1);
});
