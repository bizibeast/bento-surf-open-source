import { autoRepostSchema } from "./social-scheduler";

export type RepostPreferences = {
  enabled: boolean;
  afterHours: number;
  remove: boolean;
  removeAfterHours: number;
};

export function repostPreferences(value: unknown): RepostPreferences {
  const parsed = autoRepostSchema.safeParse(value);
  return {
    enabled: parsed.success,
    afterHours: parsed.success ? parsed.data.afterHours : 24,
    remove: parsed.success && parsed.data.removeAfterHours != null,
    removeAfterHours: parsed.success ? (parsed.data.removeAfterHours ?? 48) : 48,
  };
}

export function repostSettings(value: RepostPreferences) {
  return value.enabled
    ? {
        afterHours: value.afterHours,
        removeAfterHours: value.remove ? value.removeAfterHours : null,
      }
    : null;
}
