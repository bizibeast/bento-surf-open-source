export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfterSeconds?: number | null,
    readonly providerCode: string = code,
  ) {
    super(message);
  }
}

export function needsSocialReconnect(error: unknown) {
  return (
    error instanceof ProviderError &&
    (error.code === "reconnect_required" ||
      error.code === "invalid_grant" ||
      error.code === "refresh_token_missing" ||
      error.code === "token_revoked")
  );
}

export function socialReconnectMessage(provider: string, error: ProviderError) {
  if (error.code === "refresh_token_missing") {
    return provider === "linkedin"
      ? "LinkedIn access expired. LinkedIn did not issue a refresh token for this connection. Reconnect LinkedIn to renew posting access."
      : "Account access expired and no refresh token is available. Reconnect this account to renew access.";
  }
  return `The platform rejected account authorization (${error.providerCode}). Reconnect this account to renew access.`;
}
