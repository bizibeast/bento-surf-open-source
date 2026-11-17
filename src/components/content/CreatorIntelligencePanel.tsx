import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  creatorIntelligencePreferenceFields,
  type CreatorIntelligencePreferences,
} from "@/lib/creator-intelligence";
import {
  readCreatorIntelligence,
  updateCreatorIntelligencePreferences,
} from "@/lib/creator-intelligence.functions";

export function CreatorIntelligencePanel({ workspaceId }: { workspaceId: string }) {
  return <CreatorIntelligenceWorkspace key={workspaceId} workspaceId={workspaceId} />;
}

function CreatorIntelligenceWorkspace({ workspaceId }: { workspaceId: string }) {
  const fieldId = useId();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<CreatorIntelligencePreferences | null>(null);
  const [message, setMessage] = useState("");
  const queryKey = ["creator-intelligence", workspaceId] as const;
  const intelligence = useQuery({
    queryKey,
    queryFn: () => readCreatorIntelligence({ data: { workspaceId } }),
  });
  const save = useMutation({
    mutationFn: (preferences: CreatorIntelligencePreferences) =>
      updateCreatorIntelligencePreferences({ data: { workspaceId, preferences } }),
    onSuccess: async (preferences, submitted) => {
      queryClient.setQueryData(queryKey, (existing: typeof intelligence.data) =>
        existing ? { ...existing, preferences } : existing,
      );
      setDraft(null);
      setMessage(
        Object.keys(submitted).length
          ? "Saved creator preferences."
          : "Cleared creator preferences.",
      );
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  if (intelligence.isError) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-border px-4 py-2 text-sm">
        <p>Creator intelligence could not be loaded.</p>
        <Button type="button" size="sm" variant="ghost" onClick={() => void intelligence.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  if (!intelligence.data) return null;

  const { preferences, profile, brain, brand, social } = intelligence.data;
  const fields = draft ?? preferences;
  const hasPreferences = Object.keys(preferences).length > 0;
  const hasChanges =
    draft !== null &&
    creatorIntelligencePreferenceFields.some(
      ({ key }) => (draft[key] ?? "").trim() !== (preferences[key] ?? ""),
    );
  return (
    <details className="group rounded-xl border border-border bg-card">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden">
        <SlidersHorizontal className="size-4 text-muted-foreground" aria-hidden />
        Creator intelligence
        <ChevronDown
          className="ml-auto size-4 text-muted-foreground transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>
      <div className="grid gap-4 border-t border-border p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.6fr)]">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (hasChanges) save.mutate(fields);
          }}
          className="space-y-3"
        >
          <p className="text-sm text-muted-foreground">
            Benny and connected assistants use these preferences when helping with your content.
          </p>
          <fieldset disabled={save.isPending} className="space-y-3">
            {creatorIntelligencePreferenceFields.map(({ key, label, maxLength }) => (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={`${fieldId}-${key}`}>{label}</Label>
                <Textarea
                  id={`${fieldId}-${key}`}
                  value={fields[key] ?? ""}
                  maxLength={maxLength}
                  rows={2}
                  onChange={(event) => {
                    setMessage("");
                    save.reset();
                    setDraft({ ...fields, [key]: event.currentTarget.value });
                  }}
                />
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={!hasChanges}>
                Save preferences
              </Button>
              {hasPreferences && (
                <Button type="button" size="sm" variant="outline" onClick={() => save.mutate({})}>
                  Clear preferences
                </Button>
              )}
            </div>
          </fieldset>
          {save.isError ? (
            <p role="alert" className="text-sm text-destructive">
              Creator preferences could not be saved.
            </p>
          ) : message ? (
            <p role="status" className="text-sm text-muted-foreground">
              {message}
            </p>
          ) : null}
        </form>
        <div className="space-y-2 text-sm text-muted-foreground">
          <h3 className="font-medium text-foreground">Workspace context</h3>
          {profile?.topics.length ? <p>Topics · {profile.topics.join(", ")}</p> : null}
          {brain.hasConfirmedProfile && <p>Confirmed Brain profile</p>}
          {brain.writingVoice && <p>{brain.writingVoice}</p>}
          {brand && (
            <div className="flex items-center gap-2">
              Brand colors
              {[brand.accentColor, brand.backgroundColor, brand.textColor].map((color, index) => (
                <span
                  key={index}
                  className="size-3.5 rounded-full border border-border"
                  style={{ backgroundColor: color }}
                  aria-label={color}
                  role="img"
                />
              ))}
            </div>
          )}
          {social?.posts.length ? (
            <p>
              {social.posts.length} recent {social.posts.length === 1 ? "post" : "posts"} with
              stored social data
            </p>
          ) : null}
          {!profile?.topics.length &&
            !brain.hasConfirmedProfile &&
            !brain.writingVoice &&
            !brand &&
            !social?.posts.length && (
              <p>
                Saved topics, confirmed Brain context, brand settings, and recent social data appear
                here as you add them.
              </p>
            )}
        </div>
      </div>
    </details>
  );
}
