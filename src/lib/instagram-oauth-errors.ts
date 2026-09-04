type InstagramOAuthFailure = {
  error?: string | null;
  errorDescription?: string | null;
  failureMessage?: string | null;
};

const SAFE_SERVER_MESSAGES = [
  "This Instagram connection link expired.",
  "This Instagram account is already connected",
  "Instagram did not grant the permissions Bento needs.",
  "Instagram connected, but Meta did not confirm",
  "Instagram connected, but Bento could not save",
  "Instagram did not return an access token.",
  "Instagram did not return a long-lived access token.",
  "Instagram did not return an account profile.",
] as const;

function includesAny(value: string, needles: readonly string[]) {
  return needles.some((needle) => value.includes(needle));
}

/**
 * Converts provider and server failures into stable, user-facing recovery copy.
 * Meta error descriptions are deliberately not rendered verbatim because they
 * can contain implementation details and frequently change between API versions.
 */
export function instagramOAuthFailureMessage({
  error,
  errorDescription,
  failureMessage,
}: InstagramOAuthFailure) {
  const normalizedError = error?.trim().toLowerCase() ?? "";
  const providerText = `${normalizedError} ${errorDescription ?? ""}`.toLowerCase();

  if (
    includesAny(providerText, [
      "access_denied",
      "user_denied",
      "user denied",
      "cancelled",
      "canceled",
      "declined",
    ])
  ) {
    return "Instagram connection was cancelled. No account access was saved.";
  }

  if (
    includesAny(providerText, [
      "invalid scope",
      "invalid_scope",
      "not approved",
      "app review",
      "app is not active",
      "app not active",
      "not available to this user",
      "not a tester",
      "insufficient developer role",
    ])
  ) {
    return "This Instagram account is not currently eligible to authorize Bento. While Meta App Review is in progress, only accounts assigned as Meta testers can connect.";
  }

  if (
    includesAny(providerText, [
      "professional account",
      "business account",
      "creator account",
      "account type is not supported",
    ])
  ) {
    return "Bento Auto DMs require an Instagram Business or Creator account. Change the account type in Instagram, then reconnect.";
  }

  const trimmedFailure = failureMessage?.trim() ?? "";
  const safeFailure = SAFE_SERVER_MESSAGES.find((prefix) => trimmedFailure.startsWith(prefix));
  if (safeFailure) return trimmedFailure;

  if (includesAny(trimmedFailure.toLowerCase(), ["rate limit", "too many requests"])) {
    return "Too many Instagram connection attempts were made. Wait a moment, then try again.";
  }

  if (!error && !failureMessage) {
    return "Instagram did not return a valid connection. Start the connection again.";
  }

  return "Instagram could not be connected. Return to Auto DMs and try again.";
}

/**
 * Server-function failures can cross a serialization boundary and lose their
 * Error prototype. Read only the message field so the allow-list above still
 * controls what is rendered to the user.
 */
export function instagramOAuthFailureFromUnknown(error: unknown) {
  const failureMessage =
    error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error
        ? String(error.message)
        : typeof error === "string"
          ? error
          : null;

  return instagramOAuthFailureMessage({ failureMessage });
}
