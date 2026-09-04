import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { ZodError } from "zod";

import { renderErrorPage } from "./lib/error-page";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-attacher";
import { captureServerException } from "@/lib/posthog.server";
import {
  enforceRequestRateLimit,
  enforceServerFunctionRequestLimits,
  RequestHttpError,
} from "@/lib/request-security.server";

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error instanceof RequestHttpError) {
      const headers = new Headers({ "cache-control": "no-store" });
      if (error.statusCode === 401) headers.set("www-authenticate", "Bearer");
      if (error.statusCode === 429) headers.set("retry-after", "60");
      return Response.json({ error: error.message }, { status: error.statusCode, headers });
    }
    if (error instanceof ZodError) {
      return Response.json(
        { error: "Invalid request" },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    await captureServerException(error, "bento-worker", { surface: "tanstack_middleware" });
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

const serverFnRateLimitMiddleware = createMiddleware().server(async ({ next }) => {
  const { getRequest } = await import("@tanstack/react-start/server");
  if (new URL(getRequest().url).pathname.startsWith("/_serverFn/")) {
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "server-function");
  }
  return next();
});

const serverFnRequestLimitMiddleware = createMiddleware().server(async ({ next }) => {
  const { getRequest } = await import("@tanstack/react-start/server");
  await enforceServerFunctionRequestLimits(getRequest());
  return next();
});

const csrfMiddleware = createCsrfMiddleware({
  filter: (context) => context.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
  requestMiddleware: [
    csrfMiddleware,
    errorMiddleware,
    serverFnRateLimitMiddleware,
    serverFnRequestLimitMiddleware,
  ],
  functionMiddleware: [attachSupabaseAuth],
}));
