import { useId, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { getBennyAiSettings } from "@/lib/benny-byok.functions";
import { generateContentStudioDraft } from "@/lib/content-studio-generation.functions";
import { bennyModelSelection } from "@/lib/benny-models";
import type { StudioDocument } from "@/lib/content-studio";

export function StudioGeneration({
  workspaceId,
  title,
  document,
  onApply,
}: {
  workspaceId: string;
  title: string;
  document: StudioDocument;
  onApply: (result: { title: string; document: StudioDocument }) => void;
}) {
  const field = useId();
  const [open, setOpen] = useState(false);
  const [override, setOverride] = useState<string>();
  const [prompt, setPrompt] = useState("");
  const settings = useQuery({
    queryKey: ["benny-ai-settings"],
    queryFn: () => getBennyAiSettings(),
    enabled: open,
  });
  const selection = bennyModelSelection(settings.data, override);
  const generate = useMutation({
    mutationFn: () =>
      generateContentStudioDraft({
        data: {
          workspaceId,
          prompt,
          title,
          document,
          ...selection.input,
        },
      }),
    onSuccess: (result) => {
      onApply(result);
      setOpen(false);
    },
  });
  if (!open) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        Generate draft
      </Button>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <label htmlFor={`${field}-prompt`} className="text-sm font-medium">
        What are you creating?
      </label>
      <textarea
        id={`${field}-prompt`}
        maxLength={3000}
        rows={3}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        className="block w-full rounded-md border border-border bg-background p-2 text-sm"
        placeholder="Topic, main point, and facts to include"
      />
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Studio generation model"
          value={selection.valid ? selection.choice : ""}
          onChange={(event) => setOverride(event.target.value)}
          disabled={generate.isPending}
          className="h-9 max-w-full rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value="">Choose a model</option>
          {selection.options.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <Button
          type="button"
          size="sm"
          disabled={generate.isPending || prompt.trim().length < 3 || !selection.valid}
          onClick={() => generate.mutate()}
        >
          {generate.isPending ? "Generating…" : "Replace draft copy"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={generate.isPending}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
      {!settings.isPending && !selection.options.length && (
        <p className="text-sm text-muted-foreground">
          Generation needs an AI model.{" "}
          <Link
            to="/settings"
            search={{ section: "ai-providers" }}
            className="font-medium text-primary underline"
          >
            View AI provider settings
          </Link>
        </p>
      )}
      {generate.isError && (
        <p role="alert" className="text-sm text-destructive">
          {generate.error.message}
        </p>
      )}
    </div>
  );
}
