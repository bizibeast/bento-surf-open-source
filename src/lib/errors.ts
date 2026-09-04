export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function errorName(error: unknown): string | null {
  return error instanceof Error ? error.name : null;
}
