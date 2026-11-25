import { useState } from "react";
import { Check, UserRound } from "lucide-react";

type Look = { id: string; name: string; previewImageUrl?: string | null; avatarType?: string };
function LookImage({ look }: { look: Look }) {
  const [failed, setFailed] = useState(false);
  return look.previewImageUrl && !failed ? (
    <img
      src={look.previewImageUrl}
      alt={`${look.name} avatar preview`}
      onError={() => setFailed(true)}
      loading="lazy"
      referrerPolicy="no-referrer"
      className="h-full w-full object-cover"
    />
  ) : (
    <div className="flex h-full flex-col items-center justify-center gap-2 bg-muted text-muted-foreground">
      <UserRound aria-hidden="true" size={32} />
      <span className="text-xs">Preview unavailable</span>
    </div>
  );
}

/** Only ready, authorized looks returned by the existing catalog read. Selection never generates footage. */
export function AvatarLookGallery({
  looks,
  selectedId,
  onSelect,
  disabled = false,
}: {
  looks: Look[];
  selectedId: string;
  onSelect: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="min-w-0 space-y-3">
      <legend className="text-sm font-medium">Choose your presenter</legend>
      <p className="text-xs text-muted-foreground">
        Compare available looks. Selecting a face does not generate a video.
      </p>
      {selectedId && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onSelect("")}
          className="content-action"
        >
          Clear presenter selection
        </button>
      )}
      {!looks.length && (
        <p className="text-sm text-muted-foreground">
          No ready looks in this library. Try another library or check your connection.
        </p>
      )}
      {selectedId && !looks.some((l) => l.id === selectedId) && (
        <p className="text-xs text-muted-foreground">
          Your previously selected look is retained. Load more options to find its preview.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {looks.map((look) => {
          const selected = look.id === selectedId;
          return (
            <button
              type="button"
              key={look.id}
              disabled={disabled}
              aria-label={`Use ${look.name}`}
              aria-pressed={selected}
              onClick={() => {
                if (!selected) onSelect(look.id);
              }}
              className={`min-w-0 overflow-hidden rounded-xl border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${selected ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border bg-background hover:border-primary/60"}`}
            >
              <div className="aspect-[3/4] overflow-hidden">
                <LookImage key={`${look.id}:${look.previewImageUrl}`} look={look} />
              </div>
              <div className="space-y-2 p-3">
                <strong className="block break-words text-sm">{look.name}</strong>
                <span
                  className={`flex min-h-8 items-center gap-1.5 text-xs ${selected ? "font-medium text-primary" : "text-muted-foreground"}`}
                >
                  {selected && <Check size={14} aria-hidden="true" />}
                  {selected ? "Selected presenter" : "Use this face"}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
