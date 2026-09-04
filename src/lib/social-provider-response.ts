/** TikTok (and some other) APIs return `error: { code: "ok" }` on success. */
export function socialApiPayloadHasError(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const error = (payload as { error?: unknown }).error;
  if (!error) return false;
  if (typeof error === "string") return true;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return !["ok", "0", 0].includes(code as never);
  }
  return true;
}

export function socialApiErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const data = payload as {
    error?: string | { message?: unknown };
    error_description?: unknown;
  };
  const fromDescription =
    typeof data.error_description === "string" ? data.error_description.trim() : "";
  if (fromDescription) return fromDescription;
  if (typeof data.error === "string" && data.error.trim()) return data.error.trim();
  if (data.error && typeof data.error === "object") {
    const message = String(data.error.message || "").trim();
    if (message) return message;
  }
  return fallback;
}
