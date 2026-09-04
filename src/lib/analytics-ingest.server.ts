import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  analyticsEventInputSchema,
  enrichAnalyticsEvent,
  type AnalyticsEvent,
} from "@/lib/analytics-event";
import { readRequestText, RequestBodyTooLargeError } from "@/lib/request-security.server";

const MAX_EVENT_BODY_BYTES = 2_048;

type AnalyticsQueueEnvironment = {
  APP_ENV?: string;
  ANALYTICS_QUEUE?: Queue<AnalyticsEvent>;
  ANALYTICS_QUEUE_1?: Queue<AnalyticsEvent>;
  ANALYTICS_QUEUE_2?: Queue<AnalyticsEvent>;
  ANALYTICS_QUEUE_3?: Queue<AnalyticsEvent>;
  ANALYTICS_RATE_LIMITER?: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
};

type AnalyticsRequestContext = {
  waitUntil?: (promise: Promise<unknown>) => void;
};

function jsonError(message: string, status: number) {
  const headers = new Headers({ "cache-control": "no-store" });
  if (status === 429) headers.set("retry-after", "60");
  return Response.json({ error: message }, { status, headers });
}

function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) {
    const fetchSite = request.headers.get("sec-fetch-site");
    return !fetchSite || fetchSite === "same-origin" || fetchSite === "same-site";
  }
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function analyticsQueue(env: AnalyticsQueueEnvironment | undefined, userId: string) {
  const shards = [
    env?.ANALYTICS_QUEUE,
    env?.ANALYTICS_QUEUE_1,
    env?.ANALYTICS_QUEUE_2,
    env?.ANALYTICS_QUEUE_3,
  ].filter((queue): queue is Queue<AnalyticsEvent> => Boolean(queue));
  if (!shards.length) return null;
  let hash = 2166136261;
  for (let index = 0; index < userId.length; index += 1) {
    hash ^= userId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return shards[(hash >>> 0) % shards.length];
}

export async function handleAnalyticsEventRequest(
  request: Request,
  env: AnalyticsQueueEnvironment | undefined,
  context?: AnalyticsRequestContext,
) {
  if (request.method !== "POST") return jsonError("Method not allowed", 405);
  if (!isSameOrigin(request)) return jsonError("Invalid origin", 403);
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
    return jsonError("Expected application/json", 415);
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_EVENT_BODY_BYTES) {
    return jsonError("Event payload is too large", 413);
  }
  if (!env?.ANALYTICS_QUEUE) return jsonError("Analytics ingestion is unavailable", 503);

  let rawBody: string;
  try {
    rawBody = await readRequestText(request, MAX_EVENT_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return jsonError("Event payload is too large", 413);
    }
    return jsonError("Unable to read event payload", 400);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonError("Invalid JSON", 400);
  }
  const parsed = analyticsEventInputSchema.safeParse(payload);
  if (!parsed.success) return jsonError("Invalid analytics event", 400);

  if (!env.ANALYTICS_RATE_LIMITER && (env.APP_ENV === "production" || env.APP_ENV === "staging")) {
    return jsonError("Analytics ingestion is unavailable", 503);
  }
  if (env.ANALYTICS_RATE_LIMITER) {
    const clientIp = request.headers.get("cf-connecting-ip")?.trim() || "missing-cloudflare-ip";
    const outcome = await env.ANALYTICS_RATE_LIMITER.limit({
      key: `${parsed.data.user_id}:${clientIp}`.slice(0, 512),
    });
    if (!outcome.success) return jsonError("Analytics rate limit exceeded", 429);
  }

  const queue = analyticsQueue(env, parsed.data.user_id);
  if (!queue) return jsonError("Analytics ingestion is unavailable", 503);
  const delivery = queue.send(enrichAnalyticsEvent(request, parsed.data));
  if (typeof context?.waitUntil === "function") {
    context.waitUntil(
      delivery.catch((error) => {
        console.warn("[analytics] queue delivery failed after acknowledgement", error);
      }),
    );
  } else {
    await delivery;
  }
  return new Response(null, {
    status: 202,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
    },
  });
}

export async function insertAnalyticsEventBatch(events: AnalyticsEvent[]) {
  if (!events.length) return;
  if (events.length > 100) throw new Error("Analytics batch exceeds the database limit of 100");
  const { error } = await supabaseAdmin.rpc(
    "ingest_analytics_batch" as never,
    {
      p_events: events,
    } as never,
  );
  if (error) throw new Error(`Analytics batch insert failed: ${error.message}`);
}
