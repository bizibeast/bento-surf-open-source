import { supabaseAdmin } from "@/integrations/supabase/client.server";

type RefreshRpc =
  "claim_discover_refresh" | "is_discover_refresh_current" | "release_discover_refresh";

export type DiscoverRefreshDependencies = {
  db: {
    rpc(
      name: RefreshRpc,
      input: { p_user_id: string; p_lease_key?: string },
    ): PromiseLike<{ data: unknown; error: unknown }>;
  };
};

export type DiscoverRefreshLease = {
  leaseKey: string;
  /** Check immediately before saving so a timed-out worker cannot save stale results. */
  assertCurrent(): Promise<void>;
};

/**
 * Serializes expensive discovery for one user across Worker instances. Database
 * transactions only claim/check/release the lease; no network work holds a lock.
 * The 120-second lease exceeds the refresh's bounded provider-work budget.
 */
export async function withDiscoverRefreshLease<T>(
  userId: string,
  work: (lease: DiscoverRefreshLease) => Promise<T>,
  dependencies: DiscoverRefreshDependencies = {
    db: supabaseAdmin as unknown as DiscoverRefreshDependencies["db"],
  },
): Promise<T> {
  let claim: { data: unknown; error: unknown };
  try {
    claim = await dependencies.db.rpc("claim_discover_refresh", { p_user_id: userId });
  } catch {
    throw new Error("Discover refresh could not start. Retrying shortly.");
  }
  if (claim.error) {
    throw new Error("Discover refresh could not start. Retrying shortly.");
  }
  if (typeof claim.data !== "string" || !claim.data) {
    throw new Error("Discover refresh is already running. Retrying shortly.");
  }

  const leaseKey = claim.data;
  const ownership = { p_user_id: userId, p_lease_key: leaseKey };
  try {
    return await work({
      leaseKey,
      async assertCurrent() {
        let current: { data: unknown; error: unknown };
        try {
          current = await dependencies.db.rpc("is_discover_refresh_current", ownership);
        } catch {
          throw new Error("Discover refresh was interrupted. Retrying shortly.");
        }
        if (current.error || current.data !== true) {
          throw new Error("Discover refresh was interrupted. Retrying shortly.");
        }
      },
    });
  } finally {
    // A failed release expires naturally. Never obscure the work's result/error,
    // and never release a newer worker's lease after an expired claim is replaced.
    try {
      const released = await dependencies.db.rpc("release_discover_refresh", ownership);
      if (released.error) console.warn("[Discover] Refresh lease release deferred.");
    } catch {
      console.warn("[Discover] Refresh lease release deferred.");
    }
  }
}
