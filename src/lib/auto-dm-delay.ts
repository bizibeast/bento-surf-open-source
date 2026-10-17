import { z } from "zod";

export const AUTO_DM_DELAYS = [30, 60, 120, 180] as const;
export const DEFAULT_AUTO_DM_DELAY = 60;
export const autoDmDelaySchema = z.union([
  z.literal(30),
  z.literal(60),
  z.literal(120),
  z.literal(180),
]);
export function autoDmDelay(value: unknown): number {
  return autoDmDelaySchema.safeParse(value).data ?? DEFAULT_AUTO_DM_DELAY;
}
