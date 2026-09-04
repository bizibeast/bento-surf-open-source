type AuthChangeEvent =
  | "INITIAL_SESSION"
  | "SIGNED_IN"
  | "SIGNED_OUT"
  | "TOKEN_REFRESHED"
  | "USER_UPDATED"
  | "PASSWORD_RECOVERY"
  | (string & {});

/**
 * Decide whether a Supabase auth event should invalidate TanStack Router.
 * Recovering an existing session on refresh emits INITIAL_SESSION and often a
 * follow-up SIGNED_IN for the same user. Invalidating during that handshake
 * re-enters getSession() while the auth lock is held and leaves ssr:false
 * routes on a blank pending page.
 */
export function shouldInvalidateRouterForAuthEvent(
  event: AuthChangeEvent,
  sessionUserId: string | null,
  lastUserId: string | null | undefined,
): { invalidate: boolean; nextUserId: string | null } {
  if (event === "INITIAL_SESSION") {
    return { invalidate: false, nextUserId: sessionUserId };
  }

  // SIGNED_IN can beat INITIAL_SESSION on refresh. The first route load already
  // has this session, so invalidating it blanks ssr:false pages.
  if (lastUserId === undefined) {
    return { invalidate: false, nextUserId: sessionUserId };
  }

  if (event === "SIGNED_IN" && lastUserId === sessionUserId) {
    return { invalidate: false, nextUserId: sessionUserId };
  }

  if (!["SIGNED_IN", "SIGNED_OUT", "USER_UPDATED"].includes(event)) {
    return { invalidate: false, nextUserId: lastUserId };
  }

  return { invalidate: true, nextUserId: sessionUserId };
}
