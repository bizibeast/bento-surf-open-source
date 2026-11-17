import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getBillingCatalog, hasPlanEntitlement } from "./plan.server";
import { FULLY_MANAGED_BILLING_CATALOG } from "./plans";
import { getManagedSpendStatus } from "./provider-budget.server";
import { hasBennySearchKey, setBennySearchKey } from "./benny-web-search.server";
import { enforceRequestRateLimit } from "./request-security.server";
import {
  bennyProviderCatalogInputSchema,
  bennyProviderIdSchema,
  bennyProviderInputSchema,
  bennyProviderKeySchema,
} from "./benny-byok";
import {
  bennyProviderTarget,
  canUseBennyByok,
  deleteBennyProvider,
  discoverBennyModels,
  discoverSavedBennyModels,
  loadBennyProviderPreferences,
  saveBennyProvider,
  setBennyDefaultProvider,
} from "./benny-byok.server";

async function requireProviderSettings(workspaceId: string) {
  if (!(await canUseBennyByok(workspaceId)))
    throw new Error("Benny provider settings are unavailable.");
  await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "benny-byok-settings", workspaceId);
}

export const getBennyAiSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [connectAvailable, catalog] = await Promise.all([
      canUseBennyByok(context.workspaceId),
      getBillingCatalog(context.workspaceId),
    ]);
    const managedContract = catalog === FULLY_MANAGED_BILLING_CATALOG;
    if (!connectAvailable && !managedContract) return null;
    const [preferences, managedAvailable, searchConnected, managedUsage] = await Promise.all([
      connectAvailable
        ? loadBennyProviderPreferences(context)
        : { providers: [], defaultProviderId: null },
      hasPlanEntitlement(context.workspaceId, "brain"),
      connectAvailable ? hasBennySearchKey(context) : false,
      managedContract
        ? getManagedSpendStatus(context.workspaceId, { authUserId: context.authUserId })
        : null,
    ]);
    const searchCost = Number(process.env.BENNY_MANAGED_BRAVE_COST_MICROUSD);
    const managedSearch =
      managedUsage?.eligible === true &&
      Boolean(process.env.BENNY_MANAGED_BRAVE_API_KEY?.trim()) &&
      Number.isSafeInteger(searchCost) &&
      searchCost >= 5_000;
    return {
      ...preferences,
      connectAvailable,
      compatibleAvailable: Boolean(process.env.BENNY_BYOK_CUSTOM_BASE_URLS?.trim()),
      managedAvailable,
      searchConnected,
      managedSearch,
      managedUsage,
    };
  });

export const saveBennyAiProvider = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => bennyProviderInputSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireProviderSettings(context.workspaceId);
    return saveBennyProvider(context, data);
  });

export const getBennyAiModels = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => bennyProviderCatalogInputSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireProviderSettings(context.workspaceId);
    return "id" in data
      ? discoverSavedBennyModels(context, data.id)
      : discoverBennyModels(
          data.apiKey,
          fetch,
          bennyProviderTarget(data.kind ?? "openrouter", data.baseUrl),
        );
  });

export const removeBennyAiProvider = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: bennyProviderIdSchema }).parse(input))
  .handler(async ({ context, data }) => {
    await requireProviderSettings(context.workspaceId);
    await deleteBennyProvider(context, data.id);
  });

export const updateBennyAiDefault = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: bennyProviderIdSchema.nullable() }).parse(input))
  .handler(async ({ context, data }) => {
    await requireProviderSettings(context.workspaceId);
    await setBennyDefaultProvider(context, data.id);
  });

export const updateBennySearchKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ key: bennyProviderKeySchema.nullable() }).parse(input))
  .handler(async ({ context, data }) => {
    await requireProviderSettings(context.workspaceId);
    await setBennySearchKey(context, data.key);
  });
