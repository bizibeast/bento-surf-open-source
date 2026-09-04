import { redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { sanitizeLocalRedirect } from "@/lib/safe-url";

const PUBLIC_AUTH_ROUTES = new Set(["/login", "/signup"]);
const ONBOARDED_TTL_MS = 5 * 60_000;

type OnboardedCache = {
  userId: string;
  onboarded: boolean;
  expiresAt: number;
};

let onboardedCache: OnboardedCache | null = null;

export function clearOnboardedCache() {
  onboardedCache = null;
}

export function rememberOnboarded(userId: string, onboarded: boolean) {
  onboardedCache = {
    userId,
    onboarded,
    expiresAt: Date.now() + ONBOARDED_TTL_MS,
  };
}

export function readOnboardedCache(userId: string): boolean | null {
  if (!onboardedCache || onboardedCache.userId !== userId) return null;
  if (onboardedCache.expiresAt <= Date.now()) {
    onboardedCache = null;
    return null;
  }
  return onboardedCache.onboarded;
}

async function readAuthenticatedUserId() {
  const { data, error } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (error || typeof userId !== "string") {
    clearOnboardedCache();
    return null;
  }
  return userId;
}

function isInvalidSessionError(error: { code?: string; message?: string }) {
  return (
    error.code === "42501" ||
    error.code === "PGRST301" ||
    /(?:jwt|token).*(?:expired|invalid)|permission denied/i.test(error.message ?? "")
  );
}

async function readOnboardedStatus(userId: string): Promise<boolean | null> {
  const cached = readOnboardedCache(userId);
  if (cached !== null) return cached;

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("onboarded")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    if (!isInvalidSessionError(error)) throw error;
    clearOnboardedCache();
    await supabase.auth.signOut({ scope: "local" });
    return null;
  }
  const onboarded = profile?.onboarded === true;
  rememberOnboarded(userId, onboarded);
  return onboarded;
}

/**
 * Gate authenticated product routes. Session lookup is local; the onboarded
 * profile check is cached so switching apps does not wait on Supabase.
 */
export async function requireAuthenticatedCreator(pathname: string, href: string) {
  const userId = await readAuthenticatedUserId();
  if (!userId) {
    throw redirect({ to: "/login", search: { redirect: href } });
  }
  if (pathname === "/onboarding") return { userId };

  const onboarded = await readOnboardedStatus(userId);
  if (onboarded === null) throw redirect({ to: "/login", search: { redirect: href } });
  if (!onboarded) throw redirect({ to: "/onboarding" });
  return { userId };
}

export function authenticatedEntryDestination(onboarded: boolean, requestedDestination = "/link") {
  if (!onboarded) return "/onboarding";

  const destination = sanitizeLocalRedirect(requestedDestination);
  const pathname = destination.split(/[?#]/, 1)[0];
  return PUBLIC_AUTH_ROUTES.has(pathname) ? "/link" : destination;
}

/**
 * Public auth pages are only for signed-out visitors. Resolve an existing
 * browser session before rendering them so opening /login or /signup in a new
 * tab takes the creator straight back into Bento.
 */
export async function redirectAuthenticatedVisitor(requestedDestination = "/link") {
  const userId = await readAuthenticatedUserId();
  if (!userId) return;

  const onboarded = await readOnboardedStatus(userId);
  if (onboarded === null) return;

  throw redirect({
    to: authenticatedEntryDestination(onboarded, requestedDestination),
  });
}
