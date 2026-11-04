import { useState } from "react";
import { toast } from "sonner";
import { suggestMetaAutoDmAlternatives } from "@/lib/auto-dm-copy-assistant.functions";

type Platform = "instagram" | "facebook";
type CopyKind = "opening" | "reply" | "email" | "follow" | "public";

export function AutoDmCopySuggestButton({
  platform,
  kind,
  source,
  onSuggestions,
}: {
  platform: Platform;
  kind: CopyKind;
  source: string;
  onSuggestions: (alternatives: string[]) => void;
}) {
  const [loading, setLoading] = useState(false);
  return (
    <button
      type="button"
      disabled={loading || source.trim().length < 5}
      className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
      onClick={async () => {
        setLoading(true);
        try {
          const result = await suggestMetaAutoDmAlternatives({
            data: { platform, kind, source: source.trim() },
          });
          onSuggestions(result.alternatives);
          toast.success("Suggestions added as drafts. Review before saving.");
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Could not draft alternatives.");
        } finally {
          setLoading(false);
        }
      }}
    >
      {loading ? "Drafting…" : "Suggest 2 with free AI"}
    </button>
  );
}

type Props = {
  label: string;
  value: string[];
  onChange: (value: string[]) => void;
  maxLength: number;
  required?: boolean;
  alternativesOnly?: boolean;
  platform: Platform;
  kind: CopyKind;
};

export function AutoDmMessageVariantsEditor({
  label,
  value,
  onChange,
  maxLength,
  required = true,
  alternativesOnly = false,
  platform,
  kind,
}: Props) {
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">{label}</div>
      <p className="text-xs text-muted-foreground">
        {alternativesOnly
          ? "The message above is option 1. Add two relevant alternatives or review AI drafts before saving."
          : "Write up to three relevant versions. Suggestions are drafts only."}{" "}
        Use {"{{name}}"} for the recipient's first name or handle; when Meta doesn't provide one, it
        becomes "there". Retries use the same version.
      </p>
      {alternativesOnly && (
        <AutoDmCopySuggestButton
          platform={platform}
          kind={kind}
          source={value[0] || ""}
          onSuggestions={(alternatives) => onChange([value[0] || "", ...alternatives])}
        />
      )}
      {(alternativesOnly ? [1, 2] : [0, 1, 2]).map((index) => (
        <label key={index} className="block text-xs text-muted-foreground">
          Option {index + 1}
          {index === 0 && required ? " (required)" : " (optional)"}
          <textarea
            value={value[index] || ""}
            maxLength={maxLength}
            rows={3}
            onChange={(event) => {
              const next = [value[0] || "", value[1] || "", value[2] || ""];
              next[index] = event.target.value;
              onChange(next);
            }}
            className="mt-1 w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground"
          />
        </label>
      ))}
    </div>
  );
}
