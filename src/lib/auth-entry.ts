import { getCreatorEntryState } from "./workspace.functions";
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
  // An offline browser or an auth outage must not look like a logout. The SDK
  // retains refresh tokens for retryable errors and removes revoked sessions.
  if (error && !isMissingSession(error)) throw error;
  if (error || typeof userId !== "string") {
    clearOnboardedCache();
    return null;
  }
  return userId;
}

function isMissingSession(error: { name?: string; code?: string }) {
  return (
    error.name === "AuthSessionMissingError" ||
    [
      "session_not_found",
      "session_expired",
      "refresh_token_not_found",
      "refresh_token_already_used",
    ].includes(error.code ?? "")
  );
}

function isInvalidSessionError(error: { code?: string; message?: string }) {
  return (
    error.code === "PGRST301" || /(?:jwt|token).*(?:expired|invalid)/i.test(error.message ?? "")
  );
}

async function readOnboardedStatus(userId: string): Promise<boolean | null> {
  const cached = readOnboardedCache(userId);
  if (cached !== null) return cached;

  const readProfile = () =>
    supabase.from("profiles").select("onboarded").eq("id", userId).maybeSingle();
  let { data: profile, error } = await readProfile();
  if (error) {
    if (!isInvalidSessionError(error)) throw error;
    clearOnboardedCache();
    // The access token may expire between claims verification and this query.
    // Refresh once instead of deleting a still-valid long-lived session.
    const refreshed = await supabase.auth.refreshSession();
    if (refreshed.error) {
      if (isMissingSession(refreshed.error)) return null;
      throw refreshed.error;
    }
    if (!refreshed.data.session) return null;
    if (refreshed.data.session.user.id !== userId)
      throw new Error("Your account changed in another tab. Reload to continue.");
    ({ data: profile, error } = await readProfile());
    if (error) throw error;
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
    // Product routes render a pending shell on the server (ssr: false). Load
    // login as a document so an immediate auth redirect cannot hydrate that
    // pending boundary with a different route's markup.
    throw redirect({ to: "/login", search: { redirect: href }, reloadDocument: true });
  }
  if (pathname === "/onboarding") return { userId };

  // Workspace selection is held in a signed server cookie, not the auth user ID cache.
  const { onboarded, needsBilling } = await getCreatorEntryState();
  if (needsBilling && pathname !== "/settings")
    throw redirect({ to: "/settings", search: { section: "plan" } });
  if (!onboarded && pathname !== "/settings") throw redirect({ to: "/onboarding" });
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
