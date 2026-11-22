import { useId, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import type { BrainItem, BrainItemInput } from "@/lib/content-brain";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  BENNY_EDITING_PLAYBOOKS,
  editingPlaybookMemory,
  savedEditingPlaybook,
} from "@/lib/benny-editing-playbooks";

type MemoryKind = "carousel" | "reel" | "avatar";
const kinds = [
  { id: "carousel", label: "Carousel style" },
  { id: "reel", label: "Reel editing style" },
  { id: "avatar", label: "Avatar preferences" },
] as const;

export function BennyMemory({
  children,
  items,
  onSave,
  onOpenProjects,
  onOpenBranding,
  preferencesPanel,
  initialView = "knowledge",
}: {
  children: (
    panels: Record<"creative" | "preferences", ReactNode>,
    initialSection?: "preferences",
  ) => ReactNode;
  items: BrainItem[];
  onSave: (item: BrainItemInput) => Promise<void>;
  onOpenProjects: () => void;
  onOpenBranding?: () => void;
  preferencesPanel?: ReactNode;
  initialView?: "knowledge" | "creative" | "preferences";
}) {
  const [editing, setEditing] = useState<BrainItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState<MemoryKind>("carousel");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const id = useId();
  const memories = items.filter((item) => item.tags?.includes("creative-preference"));

  const open = (item: BrainItem | null) => {
    setEditing(item);
    setCreating(true);
    setTitle(item?.title ?? "");
    setContent(item?.content ?? "");
    setNotice("");
    setKind(kinds.find((entry) => item?.tags?.includes(entry.id))?.id ?? "carousel");
  };

  const preferenceEditor = creating && (
    <form
      className="space-y-4 border-t border-border pt-5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (saving) return;
        setSaving(true);
        setNotice("");
        try {
          await onSave({
            ...(editing ? { id: editing.id } : {}),
            kind: "instruction",
            title: title.trim(),
            content: content.trim(),
            provenance: "creator",
            status: "confirmed",
            locked: editing?.locked ?? false,
            ...(editing?.sourceRef ? { sourceRef: editing.sourceRef } : {}),
            ...(editing?.sourceUrl ? { sourceUrl: editing.sourceUrl } : {}),
            tags: [
              "creative-preference",
              kind,
              ...(editing?.tags ?? []).filter(
                (tag) => tag !== "creative-preference" && !kinds.some((item) => item.id === tag),
              ),
            ].slice(0, 8),
          });
          setCreating(false);
          setNotice("Saved to Benny’s memory.");
        } catch (error) {
          setNotice(error instanceof Error ? error.message : "Could not save this preference.");
        } finally {
          setSaving(false);
        }
      }}
    >
      <div className="space-y-2">
        <Label htmlFor={`${id}-kind`}>Preference type</Label>
        <select
          id={`${id}-kind`}
          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          value={kind}
          onChange={(event) => setKind(event.target.value as MemoryKind)}
          disabled={saving}
        >
          {kinds.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input
          id={`${id}-name`}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
          maxLength={160}
          disabled={saving}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-content`}>
          {kind === "avatar" ? "Avatar, voice & usage preferences" : "Editing instructions"}
        </Label>
        <Textarea
          id={`${id}-content`}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          required
          maxLength={20000}
          rows={6}
          disabled={saving}
          placeholder={
            kind === "avatar"
              ? "Which authorized avatar to use, voice, language, and when the avatar should appear."
              : "Pacing, layout, fonts, colors, captions, transitions, and reference styles."
          }
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={saving || !title.trim() || !content.trim()}>
          {saving ? "Saving…" : "Save preference"}
        </Button>
        <Button type="button" variant="ghost" disabled={saving} onClick={() => setCreating(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
  const playbookPanel = (
    <section aria-label="Starter editing playbooks" className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">Start with an editing playbook</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Save a style to Memory, then tailor it to your brand and assets. Ask Benny to use a saved
          style by name when creating. Playbooks guide creation using the tools available to your
          model.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {BENNY_EDITING_PLAYBOOKS.map((playbook) => {
          const existing = savedEditingPlaybook(playbook, items);
          return (
            <div key={playbook.id} className="space-y-3 rounded-xl border border-border p-4">
              <div>
                <p className="text-xs text-muted-foreground">
                  {playbook.kind === "reel" ? "Reel" : "Carousel"}
                </p>
                <h4 className="mt-1 text-sm font-semibold">{playbook.title}</h4>
                <p className="mt-1 text-sm text-muted-foreground">{playbook.description}</p>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={saving || creating}
                onClick={async () => {
                  if (existing) {
                    open(existing);
                    return;
                  }
                  setSaving(true);
                  setNotice("");
                  try {
                    await onSave(editingPlaybookMemory(playbook));
                    setNotice("Saved to Benny’s memory. You can edit this style below.");
                  } catch (error) {
                    setNotice(
                      error instanceof Error ? error.message : "Could not save this playbook.",
                    );
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                {existing ? "Customize " : "Save "}
                {playbook.title}
              </Button>
            </div>
          );
        })}
      </div>
    </section>
  );
  const creativePanel = (
    <div className="benny-creative-memory">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Your creative preferences</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Save the editing styles and avatar preferences Benny should use in your content.
          </p>
        </div>
        <Button variant="outline" onClick={() => open(null)}>
          <Plus className="size-4" /> Add preference
        </Button>
      </header>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={onOpenProjects}>
          Saved designs & templates
        </Button>
        <Button variant="outline" onClick={onOpenBranding}>
          Brand & face references
        </Button>
      </div>
      {memories.length > 0 && (
        <ul className="divide-y divide-border">
          {memories.map((item) => (
            <li key={item.id}>
              <button
                className="w-full py-4 text-left text-sm hover:text-foreground"
                onClick={() => open(item)}
              >
                <span className="block font-medium">{item.title}</span>
                <span className="mt-1 block truncate text-muted-foreground">{item.content}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {preferenceEditor}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
    </div>
  );
  return children(
    {
      creative: creativePanel,
      preferences: (
        <div className="space-y-8">
          {preferencesPanel}
          {playbookPanel}
          {preferenceEditor}
          {notice && (
            <p role="status" className="text-sm text-muted-foreground">
              {notice}
            </p>
          )}
        </div>
      ),
    },
    initialView === "preferences" ? "preferences" : undefined,
  );
}
