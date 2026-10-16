import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getDiscoverPreferences, saveDiscoverPreferences } from "@/lib/content-discovery.functions";
import { toast } from "sonner";
export function DiscoverPreferences({ onSaved }: { onSaved?: () => void } = {}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["discover-preferences"],
    queryFn: () => getDiscoverPreferences(),
    enabled: open,
  });
  return (
    <details
      className="mx-4 mb-4 rounded-xl border border-border bg-card p-4"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-medium">Your Discover direction</summary>
      <p className="mt-2 text-xs text-muted-foreground">
        Guide your feed with topics and your Bento Brain. Your confirmed profile, writing voice,
        strategies, stories, and inspirations help find posts and creators that fit you.
      </p>
      {open && query.data && (
        <form
          key={query.dataUpdatedAt}
          className="mt-4 grid gap-3 sm:grid-cols-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const fields = new FormData(e.currentTarget);
            setSaving(true);
            try {
              await saveDiscoverPreferences({
                data: {
                  nicheKeywords: String(fields.get("topics"))
                    .split(",")
                    .map((item) => item.trim())
                    .filter(Boolean),
                  useBrainContext: fields.get("useBrainContext") === "on",
                  language: String(fields.get("language")),
                  region: String(fields.get("region")),
                },
              });
              await client.invalidateQueries({ queryKey: ["discover-preferences"] });
              await client.invalidateQueries({ queryKey: ["content-discover"] });
              onSaved?.();
              toast.success(
                onSaved
                  ? "Direction saved. Refreshing your recommendations…"
                  : "Direction saved. Refresh Discover to research your interests.",
              );
            } catch (error) {
              toast.error(
                error instanceof Error ? error.message : "Preferences could not be saved.",
              );
            } finally {
              setSaving(false);
            }
          }}
        >
          {[
            {
              name: "topics",
              label: "Topics, separated by commas",
              value: query.data.nicheKeywords.join(", "),
            },
            { name: "language", label: "Language", value: query.data.language },
            { name: "region", label: "Region", value: query.data.region },
          ].map((field) => (
            <label key={field.name} className="text-xs">
              {field.label}
              <input
                name={field.name}
                defaultValue={field.value}
                required={field.name !== "topics"}
                className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              />
            </label>
          ))}
          <label className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm sm:col-span-3">
            <input
              type="checkbox"
              name="useBrainContext"
              defaultChecked={query.data.useBrainContext}
              className="mt-1"
            />
            <span>
              <strong>Use my Bento Brain</strong>
              <span className="mt-1 block text-xs text-muted-foreground">
                Match recommendations to confirmed context in your Brain. Leave topics empty to let
                Bento find your direction.
              </span>
            </span>
          </label>
          <button
            disabled={saving}
            className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground sm:col-span-3"
          >
            {saving ? "Saving…" : "Save direction"}
          </button>
        </form>
      )}
      {query.isError && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {query.error.message}
        </p>
      )}
    </details>
  );
}
