import { AsyncLocalStorage } from "node:async_hooks";
import { createServerOnlyFn } from "@tanstack/react-start";
import type { AiPricePolicy } from "./ai-pricing";
import { FULLY_MANAGED_DODO_PRODUCT_ENV } from "./plans";

/** Trusted workspace context only. Never derive this from a provider URL or user payload. */
type ManagedBudgetScope = { workspaceId: string; authUserId?: string };
let workspaceScope: AsyncLocalStorage<string> | undefined;
let managedScope: AsyncLocalStorage<ManagedBudgetScope> | undefined;
const getManagedScope = createServerOnlyFn(
  () => (managedScope ??= new AsyncLocalStorage<ManagedBudgetScope>()),
);
const getWorkspaceScope = createServerOnlyFn(
  () => (workspaceScope ??= new AsyncLocalStorage<string>()),
);
export function withProviderBudgetWorkspace<T>(workspaceId: string, work: () => T): T {
  return getWorkspaceScope().run(workspaceId, work);
}

export function withManagedProviderBudget<T>(scope: ManagedBudgetScope, work: () => T): T {
  const active = getManagedScope().getStore();
  if (
    active &&
    (active.workspaceId !== scope.workspaceId || active.authUserId !== scope.authUserId)
  )
    throw new ProviderBudgetError("ai_microusd", { reason: "ineligible" });
  return getManagedScope().run(scope, () => withProviderBudgetWorkspace(scope.workspaceId, work));
}

/** Enter managed metering for an existing, verified workspace contract. Legacy workspaces retain service caps. */
export async function withWorkspaceManagedProviderBudget<T>(
  scope: ManagedBudgetScope,
  work: () => T | Promise<T>,
): Promise<T> {
  const active = getManagedScope().getStore();
  if (active) {
    if (active.workspaceId !== scope.workspaceId) {
      throw new ProviderBudgetError("ai_microusd", { reason: "ineligible" });
    }
    return work();
  }
  const { getBillingCatalog } = await import("./plan.server");
  const { FULLY_MANAGED_BILLING_CATALOG } = await import("./plans");
  if ((await getBillingCatalog(scope.workspaceId)) === FULLY_MANAGED_BILLING_CATALOG) {
    return withManagedProviderBudget(scope, work);
  }
  return withProviderBudgetWorkspace(scope.workspaceId, work);
}

export type PaidResource =
  | "ai_microusd"
  | "public_ai_microusd"
  | "bright_data_requests"
  | "brave_search_requests"
  | "x_read_units"
  | "x_identity_reads"
  | "apimart_images"
  | "vision_images"
  | "seo_images"
  | "transcription_requests"
  | "mcp_media_resolutions"
  | "browser_milliseconds"
  | "studio_reel_browser_milliseconds"
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
    const period =
      details.reason === "managed_billing_month"
        ? "billing period"
        : details.reason?.endsWith("month")
          ? "monthly"
          : details.reason?.endsWith("week")
            ? "weekly"
            : "daily";
    const managed = details.reason?.startsWith("managed_");
    const owner = managed
      ? "Your"
      : details.reason?.startsWith("workspace_")
        ? "This workspace's"
        : "The service's";
    super(
      reset
        ? `${owner} ${period} ${managed ? "managed provider" : "AI"} allowance is used up. New Brain updates and drafts can resume after ${reset.slice(0, 10)} at ${reset.slice(11, 16)} UTC. Your saved content is safe.`
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
export type ProviderUsageReservation = { id: string; units: number; managed?: true };

type ManagedAllowance = { limitMicrousd: number; remainingMicrousd: number; resetsAt: string };
export type ManagedSpendStatus =
  | {
      eligible: true;
      weekly: ManagedAllowance;
      monthly: ManagedAllowance;
      billing?: ManagedAllowance;
    }
  | { eligible: false; reason: "ineligible" | "self_hosted" | "unavailable" };

async function budgetRpcClient(client?: BudgetClient): Promise<BudgetClient> {
  return (
    client ||
    ((await import("@/integrations/supabase/client.server")).supabaseAdmin as BudgetClient)
  );
}

function isManagedAllowance(value: unknown): value is ManagedAllowance {
  if (!value || typeof value !== "object") return false;
  const item = value as ManagedAllowance;
  return (
    Number.isSafeInteger(item.limitMicrousd) &&
    Number.isSafeInteger(item.remainingMicrousd) &&
    item.remainingMicrousd >= 0 &&
    item.remainingMicrousd <= item.limitMicrousd &&
    typeof item.resetsAt === "string" &&
    Number.isFinite(Date.parse(item.resetsAt))
  );
}

export async function getManagedSpendStatus(
  workspaceId: string,
  options: { authUserId?: string; client?: BudgetClient } = {},
): Promise<ManagedSpendStatus> {
  if (process.env.BENTO_EDITION === "self_hosted")
    return { eligible: false, reason: "self_hosted" };
  const productId = process.env[FULLY_MANAGED_DODO_PRODUCT_ENV]?.trim();
  if (!productId) return { eligible: false, reason: "unavailable" };
  try {
    const { data, error } = await (
      await budgetRpcClient(options.client)
    ).rpc("get_managed_provider_spend", {
      p_workspace_id: workspaceId,
      p_auth_user_id: options.authUserId ?? null,
      p_product_id: productId,
    });
    if (!error && data && typeof data === "object") {
      const result = data as {
        eligible?: unknown;
        reason?: unknown;
        weekly?: unknown;
        monthly?: unknown;
        billing?: unknown;
      };
      if (
        result.eligible === true &&
        isManagedAllowance(result.weekly) &&
        isManagedAllowance(result.monthly)
      )
        return {
          eligible: true,
          weekly: result.weekly,
          monthly: result.monthly,
          ...(isManagedAllowance(result.billing) ? { billing: result.billing } : {}),
        };
      if (result.reason === "ineligible") return { eligible: false, reason: "ineligible" };
    }
  } catch {
    // An unavailable meter must never enable managed service.
  }
  return { eligible: false, reason: "unavailable" };
}

function budgetReservation(data: unknown, error: unknown, resource: PaidResource) {
  if (error || !data || typeof data !== "object") throw new ProviderBudgetError(resource);
  const result = data as {
    allowed?: unknown;
    reservation_id?: unknown;
    reason?: unknown;
    retry_at?: unknown;
  };
  if (result.allowed !== true) {
    throw new ProviderBudgetError(resource, {
      reason: typeof result.reason === "string" ? result.reason : undefined,
      retryAt: typeof result.retry_at === "string" ? result.retry_at : undefined,
    });
  }
  if (
    typeof result.reservation_id !== "string" ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(result.reservation_id)
  )
    throw new ProviderBudgetError(resource);
  return result.reservation_id;
}

export async function reserveManagedProviderUsage(
  options: ManagedBudgetScope & {
    units: number;
    provider: string;
    model: string;
    resource?: PaidResource;
    providerUnits?: number;
    attemptId?: string;
    client?: BudgetClient;
  },
): Promise<ProviderUsageReservation> {
  const resource = options.resource ?? "ai_microusd";
  const productId = process.env[FULLY_MANAGED_DODO_PRODUCT_ENV]?.trim();
  if (
    !Number.isSafeInteger(options.units) ||
    options.units <= 0 ||
    !productId ||
    process.env.BENTO_EDITION === "self_hosted"
  )
    throw new ProviderBudgetError(resource, { reason: "unavailable" });
  const active = getManagedScope().getStore();
  if (
    active &&
    (active.workspaceId !== options.workspaceId ||
      (options.authUserId && active.authUserId !== options.authUserId))
  )
    throw new ProviderBudgetError(resource, { reason: "ineligible" });
  try {
    const { data, error } = await (
      await budgetRpcClient(options.client)
    ).rpc("reserve_managed_provider_usage", {
      p_workspace_id: options.workspaceId,
      p_auth_user_id: options.authUserId ?? active?.authUserId ?? null,
      p_product_id: productId,
      p_attempt_id: options.attemptId ?? crypto.randomUUID(),
      p_resource: resource,
      p_provider_units: options.providerUnits ?? options.units,
      p_microusd: options.units,
      p_provider: options.provider,
      p_model: options.model,
    });
    return { id: budgetReservation(data, error, resource), units: options.units, managed: true };
  } catch (error) {
    if (error instanceof ProviderBudgetError) throw error;
    throw new ProviderBudgetError(resource);
  }
}

/** Reserve BEFORE every billable attempt. Unknown errors/timeouts keep the reservation. */
export async function reserveProviderUsage(
  resource: PaidResource,
  units = 1,
  options: {
    workspaceId?: string;
    client?: BudgetClient;
    managedCostMicrousd?: number;
    attemptId?: string;
  } = {},
): Promise<void> {
  if (!Number.isSafeInteger(units) || units <= 0) throw new ProviderBudgetError(resource);
  const managed = getManagedScope().getStore();
  if (managed || options.managedCostMicrousd !== undefined) {
    const workspaceId = options.workspaceId || managed?.workspaceId;
    if (!workspaceId || options.managedCostMicrousd === undefined)
      throw new ProviderBudgetError(resource, { reason: "unavailable" });
    await reserveManagedProviderUsage({
      workspaceId,
      authUserId: managed?.authUserId,
      units: options.managedCostMicrousd,
      providerUnits: units,
      resource,
      provider: resource === "brave_search_requests" ? "brave" : resource,
      model: resource === "brave_search_requests" ? "web_search" : resource,
      attemptId: options.attemptId,
      client: options.client,
    });
    return;
  }
  try {
    const { data, error } = await (
      await budgetRpcClient(options.client)
    ).rpc("reserve_provider_usage", {
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
    attemptId?: string;
  },
): Promise<ProviderUsageReservation> {
  if (!Number.isSafeInteger(units) || units <= 0) throw new ProviderBudgetError("ai_microusd");
  const managed = getManagedScope().getStore();
  if (managed) {
    if (options.publicTool) throw new ProviderBudgetError("ai_microusd");
    return reserveManagedProviderUsage({
      ...options,
      workspaceId: options.workspaceId || managed.workspaceId,
      authUserId: managed.authUserId,
      units,
    });
  }
  try {
    const { data, error } = await (
      await budgetRpcClient(options.client)
    ).rpc("reserve_ai_provider_usage", {
      p_units: units,
      p_workspace_id: options.workspaceId || getWorkspaceScope().getStore() || null,
      p_provider: options.provider,
      p_model: options.model,
      p_public_tool: Boolean(options.publicTool),
    });
    return { id: budgetReservation(data, error, "ai_microusd"), units };
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
  if (!reservation) return false;
  if (
    actualUnits === null ||
    !Number.isSafeInteger(actualUnits) ||
    actualUnits < 0 ||
    actualUnits > reservation.units
  ) {
    console.warn("ai_usage_settlement_rejected", {
      reservationId: reservation.id,
      reason:
        actualUnits === null
          ? "missing_cost"
          : Number.isSafeInteger(actualUnits) && actualUnits > reservation.units
            ? "above_reservation"
            : "invalid",
      reservedUnits: reservation.units,
      actualUnits,
    });
    return false;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const client = await budgetRpcClient(options.client);
    const { data, error } = await Promise.race([
      Promise.resolve(
        client.rpc(
          reservation.managed ? "settle_managed_provider_usage" : "settle_ai_provider_usage",
          { p_reservation_id: reservation.id, p_actual_units: actualUnits },
        ),
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

/** Reserve one HeyGen generation paid by the connected member before submission. */
export async function reserveHeyGenByokAttempt(input: {
  workspaceId: string;
  authUserId: string;
  jobId: string;
  client?: {
    rpc(
      name: "reserve_external_tool_call",
      args: {
        p_workspace_id: string;
        p_auth_user_id: string;
        p_provider: "heygen";
        p_action: "submit";
        p_job_id: string;
      },
    ): PromiseLike<{ data: unknown; error: unknown }>;
  };
}) {
  const client = input.client || (await budgetRpcClient());
  const { data, error } = await client.rpc("reserve_external_tool_call", {
    p_workspace_id: input.workspaceId,
    p_auth_user_id: input.authUserId,
    p_provider: "heygen",
    p_action: "submit",
    p_job_id: input.jobId,
  });
  return { data: typeof data === "string" ? data : null, error };
}
