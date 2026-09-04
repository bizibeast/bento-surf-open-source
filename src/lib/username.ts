import * as z from "zod";

const USERNAME_PATTERN = /^[a-z0-9_]+$/;

export function normalizeUsername(username: string) {
  return username.toLowerCase();
}

export const usernameSchema = z
  .string()
  .min(3)
  .max(24)
  .transform(normalizeUsername)
  .pipe(z.string().regex(USERNAME_PATTERN, "Letters, numbers, and underscore only"));
