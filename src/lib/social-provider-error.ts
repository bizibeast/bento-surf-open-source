export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfterSeconds?: number | null,
  ) {
    super(message);
  }
}

export function needsSocialReconnect(error: unknown) {
  return (
    error instanceof ProviderError &&
    (error.code === "reconnect_required" ||
      error.code === "invalid_grant" ||
      error.code === "token_revoked")
  );
}
