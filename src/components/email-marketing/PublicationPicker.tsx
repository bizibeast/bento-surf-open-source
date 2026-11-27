import { Check, ChevronDown, Plus, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { BentoIcon } from "@/components/BentoBrand";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NewsletterProductBuilder } from "@/components/commerce/NewsletterProductBuilder";
import type { NewsletterPublicationSummary } from "@/lib/newsletter-publications";

function subscriberLabel(count: number) {
  return `${count} subscriber${count === 1 ? "" : "s"}`;
}

function PublicationAvatar({ publication }: { publication: NewsletterPublicationSummary }) {
  return (
    <Avatar className="size-7 border border-black/[0.06] bg-[#f2f4f8]">
      {publication.logoUrl ? <AvatarImage src={publication.logoUrl} alt="" /> : null}
      <AvatarFallback className="bg-[#f2f4f8]">
        <BentoIcon className="size-4" />
      </AvatarFallback>
    </Avatar>
  );
}

export function PublicationPicker({
  publications,
  selectedPublicationId,
  onSelectPublication,
  onPublicationCreated,
  onOpenSettings,
  locked = false,
  loading = false,
  loadError,
}: {
  publications: NewsletterPublicationSummary[];
  selectedPublicationId: string | null;
  onSelectPublication: (publicationId: string) => void;
  onPublicationCreated: (publicationId: string) => void | Promise<void>;
  onOpenSettings?: () => void;
  locked?: boolean;
  loading?: boolean;
  loadError?: string | null;
}) {
  const selected = publications.find((publication) => publication.id === selectedPublicationId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const openDialog = () => setDialogOpen(true);
  useEffect(() => {
    if (!loading && !locked && publications.length === 0) setDialogOpen(true);
  }, [loading, locked, publications.length]);

  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        {loading ? (
          <button
            type="button"
            disabled
            className="min-h-11 rounded-lg border border-black/[0.08] px-3 text-sm text-[#17213a]/50"
          >
            Loading publications…
          </button>
        ) : publications.length ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={
                  selected
                    ? `Select publication, ${selected.title}, ${subscriberLabel(selected.subscriberCount)}`
                    : "Select publication"
                }
                className="flex h-auto min-h-9 min-w-0 max-w-64 items-center gap-2 rounded-lg border border-black/[0.08] bg-white [padding:0.35rem_0.625rem] text-sm font-semibold text-[#17213a] shadow-sm outline-none hover:bg-[#f8f9fc] focus-visible:ring-2 focus-visible:ring-[#3478f6]/30"
              >
                {selected ? <PublicationAvatar publication={selected} /> : null}
                <span className="min-w-0 flex-1 truncate text-left">
                  {selected?.title ?? "Select publication"}
                </span>
                <ChevronDown className="size-4 shrink-0 text-[#17213a]/45" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72 rounded-xl p-1.5">
              {publications.map((publication) => (
                <DropdownMenuItem
                  key={publication.id}
                  aria-label={`${publication.title}, ${subscriberLabel(publication.subscriberCount)}`}
                  onSelect={() => onSelectPublication(publication.id)}
                  className="min-h-14 rounded-lg px-2.5 py-2"
                >
                  <PublicationAvatar publication={publication} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold" title={publication.title}>
                      {publication.title}
                    </span>
                    <span className="block text-xs text-[#17213a]/50">
                      {subscriberLabel(publication.subscriberCount)}
                    </span>
                  </span>
                  {publication.id === selectedPublicationId ? (
                    <span className="flex shrink-0 items-center gap-1">
                      {onOpenSettings ? (
                        <button
                          type="button"
                          aria-label={`Open settings for ${publication.title}`}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            onOpenSettings();
                          }}
                          className="flex size-8 items-center justify-center rounded-lg text-[#17213a]/55 outline-none hover:bg-[#eef0f4] focus-visible:ring-2 focus-visible:ring-[#3478f6]/30"
                        >
                          <Settings className="size-4" />
                        </button>
                      ) : null}
                      <Check className="size-4" aria-hidden="true" />
                    </span>
                  ) : null}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              {!locked && (
                <DropdownMenuItem
                  aria-label="Add publication"
                  disabled={locked}
                  onSelect={openDialog}
                  className="min-h-11 rounded-lg px-3 font-semibold"
                >
                  <Plus className="size-4" />
                  Add publication
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : locked ? (
          <a
            href="/settings?section=plan"
            className="rounded-lg border px-3 py-2 text-sm font-semibold"
          >
            Review plan
          </a>
        ) : !loading ? (
          <button
            type="button"
            aria-label="Add publication"
            disabled={locked}
            onClick={openDialog}
            className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg border border-black/[0.08] bg-white px-3 text-sm font-semibold text-[#17213a] shadow-sm outline-none hover:bg-[#f8f9fc] focus-visible:ring-2 focus-visible:ring-[#3478f6]/30 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Plus className="size-4" />
            Add publication
          </button>
        ) : null}
      </div>

      {loadError ? (
        <p role="alert" className="text-xs text-red-600">
          {loadError}
        </p>
      ) : null}

      <NewsletterProductBuilder
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSaved={onPublicationCreated}
        creationTitle={publications.length ? "Add publication" : "Set up your publication"}
      />
    </>
  );
}
