import { AsyncLocalStorage } from "node:async_hooks";
import { createServerOnlyFn } from "@tanstack/react-start";

/** Trusted workspace context only. Never derive this from a provider URL or user payload. */
let workspaceScope: AsyncLocalStorage<string> | undefined;
const getWorkspaceScope = createServerOnlyFn(
  () => (workspaceScope ??= new AsyncLocalStorage<string>()),
);
export function withProviderBudgetWorkspace<T>(workspaceId: string, work: () => T): T {
  return getWorkspaceScope().run(workspaceId, work);
}

export type PaidResource =
  | "ai_microusd"
  | "public_ai_microusd"
  | "bright_data_requests"
  | "x_read_units"
  | "x_identity_reads"
  | "apimart_images"
  | "vision_images"
  | "seo_images"
  | "transcription_requests"
  | "browser_milliseconds"
  | "marketing_emails"
  | "transactional_emails"
  | "image_transformations"
  | "public_background_removals"
  | "analytics_events"
  | "x_write_actions"
  | "x_dm_deliveries";

export class ProviderBudgetError extends Error {
  constructor(readonly resource: PaidResource) {
    super(
      "This service's usage limit has been reached or its budget is unavailable. Existing content is safe. Please try again later.",
    );
    this.name = "ProviderBudgetError";
  }
}

type BudgetClient = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
};

/** Reserve BEFORE every billable attempt. No refunds on errors/timeouts: the provider may charge. */
export async function reserveProviderUsage(
  resource: PaidResource,
  units = 1,
  options: { workspaceId?: string; client?: BudgetClient } = {},
) {
  if (!Number.isSafeInteger(units) || units <= 0) throw new ProviderBudgetError(resource);
  const client =
    options.client || (await import("@/integrations/supabase/client.server")).supabaseAdmin;
  try {
    const { data, error } = await (client as BudgetClient).rpc("reserve_provider_usage", {
      p_resource: resource,
      p_units: units,
      p_workspace_id: options.workspaceId || getWorkspaceScope().getStore() || null,
    });
    if (error || data !== true) throw new ProviderBudgetError(resource);
  } catch {
    throw new ProviderBudgetError(resource);
  }
}

export function xBackgroundReadsEnabled() {
  return process.env.X_PAID_READS_ENABLED === "true";
}

/** X bills objects, not just requests. Reserve the largest possible expanded page. */
export async function reserveXRead(url: string | URL, workspaceId?: string) {
  const parsed = new URL(url);
  if (!["api.x.com", "api.twitter.com"].includes(parsed.hostname)) return;
  // Webhook subscription management is control-plane work, not content lookup.
  if (/^\/2\/(webhooks|account_activity|activity\/subscriptions)(\/|$)/.test(parsed.pathname))
    return;
  const identity = parsed.pathname === "/2/users/me";
  if (!identity && !xBackgroundReadsEnabled()) throw new ProviderBudgetError("x_read_units");
  const size = Number(parsed.searchParams.get("max_results") || 1);
  const units = Math.max(1, Math.min(1000, Number.isSafeInteger(size) ? size : 1000));
  await reserveProviderUsage(
    identity ? "x_identity_reads" : "x_read_units",
    identity ? 1 : units * (parsed.searchParams.has("expansions") ? 5 : 1),
    { workspaceId },
  );
}

/** Conservative token bound: UTF-8 bytes plus envelope overhead, not chars/4. */
export function aiReservationMicrousd(messages: unknown, maxTokens: number) {
  const bytes = new TextEncoder().encode(JSON.stringify(messages)).byteLength;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 8000 || bytes > 128_000)
    throw new Error("AI request is too large. Shorten the supplied content and try again.");
  // Upper routing rates: $3/M input and $15/M output. Reserve full possible output.
  return (bytes + 1024) * 3 + maxTokens * 15;
}
