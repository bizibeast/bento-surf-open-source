import { useEffect, useRef, useState } from "react";
import { Link as LinkIcon } from "lucide-react";
import { toast } from "sonner";
import { detectPlatformFromUrl } from "@/lib/platform-detection";
import { fetchLinkMetadata } from "@/lib/link-metadata.functions";
import { safeCssColor } from "@/lib/safe-url";
import { normalizeSocialEmbedContent, youtubeVideoIdFromUrl } from "@/lib/social-embeds";
import type { NewBlockPayload } from "./AddBlockPicker";

function normalizeUrl(raw: string): string {
  const v = raw.trim();
  if (!v) return v;
  if (/^https?:\/\//i.test(v)) return v;
  return `https://${v}`;
}

export function LinkPopover({
  onAdd,
  buttonClassName,
}: {
  onAdd: (payload: NewBlockPayload) => void;
  buttonClassName: string;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const handlePaste = async () => {
    try {
      const txt = await navigator.clipboard.readText();
      if (txt) {
        setValue(txt);
        setTimeout(() => submit(txt), 0);
      }
    } catch {
      toast.error("Couldn't read clipboard");
    }
  };

  const submit = async (raw?: string) => {
    const url = normalizeUrl(raw ?? value);
    if (!url) return;
    try {
      new URL(url);
    } catch {
      toast.error("Enter a valid URL");
      return;
    }

    setBusy(true);
    try {
      if (youtubeVideoIdFromUrl(url)) {
        onAdd({
          type: "video",
          content: normalizeSocialEmbedContent("youtube", { originalUrl: url }),
          w: 4,
          h: 2,
        });
      } else {
        const match = detectPlatformFromUrl(url);
        if (match?.platform.blockType === "social_link" && match.platform.urlBase) {
          onAdd({
            type: "social_link",
            content: { platform: match.platform.key, handle: match.handle, url },
            w: 1,
            h: 1,
          });
        } else {
          const meta = await fetchLinkMetadata({ data: { url } });
          const platformColor = match ? safeCssColor(match.platform.color) : null;
          onAdd({
            type: "generic_link",
            content: {
              title: match?.platform.label || meta.title,
              url: meta.url,
              description: "",
              color: meta.color || platformColor,
            },
            cover_url: meta.favicon ?? null,
            w: 2,
            h: 1,
          });
        }
      }
      setValue("");
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Add link"
        title="Add link"
        className={`${buttonClassName} ${open ? "bg-accent ring-1 ring-border" : ""}`}
      >
        <LinkIcon className="size-4" />
      </button>

      {open && (
        <div
          ref={popRef}
          className="fixed inset-x-2 bottom-20 z-40 animate-in fade-in slide-in-from-bottom-2 duration-200 sm:absolute sm:inset-x-auto sm:bottom-full sm:left-1/2 sm:mb-4 sm:-translate-x-1/2"
        >
          {/* Floating input bar */}
          <div className="mx-auto flex w-full items-center gap-2 rounded-[20px] bg-white/95 p-1.5 pl-3 shadow-[0_20px_60px_-15px_rgba(0,0,0,0.25)] ring-1 ring-black/5 backdrop-blur-xl sm:w-[380px] sm:pl-4">
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Enter Link"
              disabled={busy}
              className="min-w-0 flex-1 bg-transparent text-sm text-neutral-700 placeholder:text-neutral-400 outline-none disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => (value.trim() ? submit() : handlePaste())}
              disabled={busy}
              className="shrink-0 rounded-full bg-white px-3 py-2 text-sm font-medium text-neutral-800 shadow-sm ring-1 ring-black/5 transition hover:bg-neutral-50 disabled:opacity-50 sm:px-4"
            >
              {busy ? "…" : value.trim() ? "Add" : "Paste"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
