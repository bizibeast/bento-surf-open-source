import { AsyncLocalStorage } from "node:async_hooks";
import { createServerOnlyFn } from "@tanstack/react-start";
import type { AiPricePolicy } from "./ai-pricing";

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
  readonly retryAt?: string;
  readonly reason?: string;
  constructor(
    readonly resource: PaidResource,
    details: { reason?: string; retryAt?: string } = {},
  ) {
    const reset =
      details.retryAt && Number.isFinite(Date.parse(details.retryAt))
        ? new Date(details.retryAt).toISOString()
        : undefined;
    const period = details.reason?.endsWith("month") ? "monthly" : "daily";
    const owner = details.reason?.startsWith("workspace_") ? "This workspace's" : "The service's";
    super(
      reset
        ? `${owner} ${period} AI allowance is used up. New Brain updates and drafts can resume after ${reset.slice(0, 10)} at ${reset.slice(11, 16)} UTC. Your saved content is safe.`
        : "This service's usage limit has been reached or its budget is unavailable. Existing content is safe. Please try again later.",
    );
    this.name = "ProviderBudgetError";
    this.retryAt = reset;
    this.reason = details.reason;
  }
}

type BudgetClient = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
};
export type ProviderUsageReservation = { id: string; units: number };

/** Reserve BEFORE every billable attempt. Unknown errors/timeouts keep the reservation. */
export async function reserveProviderUsage(
  resource: PaidResource,
  units = 1,
  options: { workspaceId?: string; client?: BudgetClient } = {},
): Promise<void> {
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
  } catch (error) {
    if (error instanceof ProviderBudgetError) throw error;
    throw new ProviderBudgetError(resource);
  }
}

/** The public and overall AI pools are reserved in one atomic database operation. */
export async function reserveAiProviderUsage(
  units: number,
  options: {
    provider: string;
    model: string;
    publicTool?: boolean;
    workspaceId?: string;
    client?: BudgetClient;
  },
): Promise<ProviderUsageReservation> {
  if (!Number.isSafeInteger(units) || units <= 0) throw new ProviderBudgetError("ai_microusd");
  const client =
    options.client || (await import("@/integrations/supabase/client.server")).supabaseAdmin;
  try {
    const { data, error } = await (client as BudgetClient).rpc("reserve_ai_provider_usage", {
      p_units: units,
      p_workspace_id: options.workspaceId || getWorkspaceScope().getStore() || null,
      p_provider: options.provider,
      p_model: options.model,
      p_public_tool: Boolean(options.publicTool),
    });
    if (error || !data || typeof data !== "object") throw new ProviderBudgetError("ai_microusd");
    const result = data as {
      allowed?: unknown;
      reservation_id?: unknown;
      reason?: unknown;
      retry_at?: unknown;
    };
    if (result.allowed !== true) {
      throw new ProviderBudgetError("ai_microusd", {
        reason: typeof result.reason === "string" ? result.reason : undefined,
        retryAt: typeof result.retry_at === "string" ? result.retry_at : undefined,
      });
    }
    if (
      typeof result.reservation_id !== "string" ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(result.reservation_id)
    )
      throw new ProviderBudgetError("ai_microusd");
    return { id: result.reservation_id, units };
  } catch (error) {
    if (error instanceof ProviderBudgetError) throw error;
    throw new ProviderBudgetError("ai_microusd");
  }
}

/** Reconcile a successful response once. Ambiguity keeps the full reservation. */
export async function settleProviderUsage(
  reservation: ProviderUsageReservation | undefined,
  actualUnits: number | null,
  options: { client?: BudgetClient } = {},
) {
  if (!reservation || actualUnits === null) return false;
  if (!Number.isSafeInteger(actualUnits) || actualUnits < 0 || actualUnits > reservation.units)
    return false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const client =
      options.client || (await import("@/integrations/supabase/client.server")).supabaseAdmin;
    const { data, error } = await Promise.race([
      Promise.resolve(
        (client as BudgetClient).rpc("settle_ai_provider_usage", {
          p_reservation_id: reservation.id,
          p_actual_units: actualUnits,
        }),
      ),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Usage settlement timed out")), 2_000);
      }),
    ]);
    if (!error && data === true) return true;
  } catch {
    // Never retry a paid request because accounting was unavailable.
  } finally {
    clearTimeout(timeout);
  }
  console.warn("ai_usage_settlement_deferred", { reservationId: reservation.id });
  return false;
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
export function aiReservationMicrousd(
  messages: unknown,
  maxTokens: number,
  policy: AiPricePolicy = { input: 3, output: 15 },
) {
  const bytes = new TextEncoder().encode(JSON.stringify(messages)).byteLength;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 8000 || bytes > 128_000)
    throw new Error("AI request is too large. Shorten the supplied content and try again.");
  // Reserve the full possible output at the selected model's approved ceiling.
  return Math.ceil((bytes + 1024) * policy.input + maxTokens * policy.output);
}
