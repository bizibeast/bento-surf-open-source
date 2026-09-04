import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getPlan } from "@/lib/plan.server";
import { isPaidPlan, planLimits, type PlanId } from "@/lib/plans";
import { getMediaBucket, sumR2UserStorageBytes } from "@/lib/r2-storage.server";

type CountResult = {
  count: number | null;
  error: { message: string } | null;
};

type UsageDependencies = {
  countPages: () => PromiseLike<CountResult>;
  countBlocks: () => PromiseLike<CountResult>;
  plan?: () => Promise<PlanId>;
  /** @deprecated Test compatibility; new callers should provide plan. */
  isPro?: () => Promise<boolean>;
  storageBytes: () => Promise<number>;
};

/**
 * Assemble the settings usage snapshot while keeping storage optional. R2 is a
 * deployment binding, so local development and a partially configured Worker
 * should still be able to show database-backed usage. Database and entitlement
 * failures remain fatal rather than being mistaken for zero usage.
 */
export async function loadUsage(dependencies: UsageDependencies) {
  const [pages, blocks, plan, storageBytes] = await Promise.all([
    dependencies.countPages(),
    dependencies.countBlocks(),
    dependencies.plan
      ? dependencies.plan()
      : dependencies.isPro!().then((isPro) => (isPro ? "store" : "free")),
    Promise.resolve()
      .then(dependencies.storageBytes)
      .catch(() => 0),
  ]);
  if (pages.error) throw new Error(pages.error.message);
  if (blocks.error) throw new Error(blocks.error.message);

  const limits = planLimits(plan);
  // The root/Main profile is always present and is not stored in `pages`.
  // `maxPages` is the total including Main; only additional pages are stored.
  const pageCount = (pages.count ?? 0) + 1;
  const pageLimit = limits.maxPages;

  return {
    plan,
    isPro: isPaidPlan(plan),
    pages: pageCount,
    blocks: blocks.count ?? 0,
    storageBytes,
    storageLimitBytes: limits.storageMb * 1024 * 1024,
    pageLimit,
  };
}

export const getMyUsage = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    return loadUsage({
      countPages: () =>
        supabase.from("pages").select("id", { count: "exact", head: true }).eq("user_id", userId),
      countBlocks: () =>
        supabase.from("blocks").select("id", { count: "exact", head: true }).eq("user_id", userId),
      plan: () => getPlan(userId),
      storageBytes: () => sumR2UserStorageBytes(getMediaBucket(), userId),
    });
  });
