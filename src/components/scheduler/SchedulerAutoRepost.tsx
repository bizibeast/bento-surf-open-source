import type { RepostPreferences } from "@/lib/scheduler-repost";
import { micro } from "@/lib/micro-app-ui";

export function SchedulerAutoRepost({
  network,
  value,
  onChange,
}: {
  network: string;
  value: RepostPreferences;
  onChange: (value: RepostPreferences) => void;
}) {
  return (
    <section
      className="mt-5 rounded-2xl border border-border/70 bg-white/70 p-4"
      aria-label={`${network} auto-repost`}
    >
      <label className="flex items-center gap-3 text-sm font-semibold">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
        />
        Auto-repost on {network}
      </label>
      <p className="mt-1 text-xs text-muted-foreground">
        Repost this post on {network} after it goes live.
      </p>
      {value.enabled && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block text-xs font-semibold text-muted-foreground">
            Repost after (hours)
            <input
              type="number"
              min={1}
              max={168}
              step={1}
              value={value.afterHours}
              onChange={(event) =>
                onChange({
                  ...value,
                  afterHours: Number(event.target.value),
                  removeAfterHours: Math.max(
                    value.removeAfterHours,
                    Number(event.target.value) + 1,
                  ),
                })
              }
              className={`mt-1 ${micro.input}`}
            />
          </label>
          <label className="flex items-center gap-2 text-xs font-semibold sm:col-span-2">
            <input
              type="checkbox"
              checked={value.remove}
              onChange={(event) => onChange({ ...value, remove: event.target.checked })}
            />
            Remove the repost later
          </label>
          {value.remove && (
            <label className="block text-xs font-semibold text-muted-foreground">
              Remove after (total hours from original post)
              <input
                type="number"
                min={value.afterHours + 1}
                max={336}
                step={1}
                value={value.removeAfterHours}
                onChange={(event) =>
                  onChange({ ...value, removeAfterHours: Number(event.target.value) })
                }
                className={`mt-1 ${micro.input}`}
              />
            </label>
          )}
          <p className="text-xs text-muted-foreground sm:col-span-2">
            The original post stays published. For example, 24 and 48 hours means repost one day
            after publishing and remove that repost one day later.
          </p>
        </div>
      )}
    </section>
  );
}
