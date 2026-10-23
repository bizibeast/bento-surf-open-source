import { z } from "zod";
import { SOCIAL_PROVIDERS } from "./social-scheduler";

export const schedulerReadFiltersShape = {
  cursor: z.string().min(1).max(512).optional(),
  provider: z.enum(SOCIAL_PROVIDERS).optional(),
  connectionId: z.string().uuid().optional(),
  query: z.string().trim().min(1).max(120).optional(),
  targetStatus: z
    .enum([
      "pending",
      "queued",
      "uploading",
      "publishing",
      "processing",
      "published",
      "retrying",
      "failed",
      "cancelled",
      "outcome_unknown",
    ])
    .optional(),
  dateFrom: z.string().datetime({ offset: true }).optional(),
  dateTo: z.string().datetime({ offset: true }).optional(),
  dateField: z.enum(["published_at", "scheduled_at", "created_at"]).default("published_at"),
};
export const schedulerReadFiltersSchema = z.object(schedulerReadFiltersShape);
export type SchedulerReadFilters = z.input<typeof schedulerReadFiltersSchema>;
export const getSocialPostInputSchema = z.object({
  id: z.string().uuid(),
  attemptsCursor: z.string().max(20).regex(/^\d+$/).optional(),
  attemptsLimit: z.number().int().min(1).max(50).default(20),
});
export type GetSocialPostInput = z.input<typeof getSocialPostInputSchema>;

const cursorSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
});
export function encodeSchedulerCursor(row: { created_at: string; id: string }) {
  return btoa(JSON.stringify({ createdAt: row.created_at, id: row.id }));
}
export function decodeSchedulerCursor(cursor: string) {
  try {
    return cursorSchema.parse(JSON.parse(atob(cursor)));
  } catch {
    throw new Error("Invalid Scheduler cursor. Start a new list without a cursor.");
  }
}
export function validateSchedulerDates(filters: SchedulerReadFilters) {
  if (
    filters.dateFrom &&
    filters.dateTo &&
    Date.parse(filters.dateFrom) >= Date.parse(filters.dateTo)
  ) {
    throw new Error("dateFrom must be earlier than dateTo (exclusive).");
  }
}
