import { csrfSymbol } from "@tanstack/react-start";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { RequestHttpError } from "./lib/request-security.server";
import { startInstance } from "./start";

describe("TanStack Start middleware", () => {
  it("registers CSRF protection before the request error boundary", async () => {
    const options = await startInstance.getOptions();
    const requestMiddleware = options.requestMiddleware ?? [];

    expect(requestMiddleware).toHaveLength(4);
    expect((requestMiddleware[0] as unknown as Record<symbol, unknown>)[csrfSymbol]).toBe(true);
  });

  it.each([401, 403, 413, 429])("preserves security HTTP status %s", async (statusCode) => {
    const options = await startInstance.getOptions();
    const boundary = options.requestMiddleware?.[1] as unknown as {
      options: {
        server: (context: { next: () => Promise<never> }) => Promise<Response>;
      };
    };
    const response = await boundary.options.server({
      next: async () => {
        throw new RequestHttpError(
          statusCode,
          statusCode === 401 ? "Unauthorized" : "Too many requests",
        );
      },
    });

    expect(response.status).toBe(statusCode);
    expect(response.headers.get("cache-control")).toBe("no-store");
    if (statusCode === 401) expect(response.headers.get("www-authenticate")).toBe("Bearer");
    if (statusCode === 429) expect(response.headers.get("retry-after")).toBe("60");
  });

  it("returns a generic 400 for invalid server-function input", async () => {
    const options = await startInstance.getOptions();
    const boundary = options.requestMiddleware?.[1] as unknown as {
      options: {
        server: (context: { next: () => Promise<never> }) => Promise<Response>;
      };
    };
    const response = await boundary.options.server({
      next: async (): Promise<never> => {
        z.object({ id: z.string().uuid() }).parse({ id: "attacker-input" });
        throw new Error("unreachable");
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid request" });
  });
});
