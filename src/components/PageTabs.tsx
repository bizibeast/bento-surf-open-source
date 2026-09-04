import { useState, type CSSProperties, type MouseEvent } from "react";
import {
  BarChart3,
  CalendarDays,
  FileText,
  Home,
  Link2,
  Newspaper,
  Plus,
  Pencil,
  ShoppingBag,
  Trash2,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { safeNavigationHref } from "@/lib/safe-url";

export type PageTab = {
  id: string;
  name: string;
  slug: string;
  url?: string | null;
  href?: string | null;
  system?: "calendar" | "insights" | "store" | "newsletter";
};

type Mode = "editor" | "public";

function isLikelyUrl(v: string) {
  const t = v.trim();
  if (!t) return false;
  if (/\s/.test(t)) return false;
  if (/^https?:\/\//i.test(t)) return true;
  return /^[^\s@]+\.[a-z]{2,}(\/.*)?$/i.test(t);
}

function normalizeUrl(v: string) {
  const t = v.trim();
  if (!t) return "";
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

function hostnameOf(u: string) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
}

function faviconFor(u: string) {
  const host = hostnameOf(u);
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
}

export function PageTabs({
  pages,
  activeId, // null = home
  homeHref,
  mode,
  onSelect,
  onIntent,
  onCreate,
  onCreateCalendar,
  onCreateInsights,
  onCreateStore,
  onCreateNewsletter,
  onRename,
  onDelete,
  menuStyle,
  phoneEditor = false,
}: {
  pages: PageTab[];
  activeId: string | null;
  homeHref?: string | null;
  mode: Mode;
  onSelect: (id: string | null) => void;
  onIntent?: (id: string | null) => void;
  onCreate?: (input: { name: string; url?: string | null }) => void;
  onCreateCalendar?: () => void;
  onCreateInsights?: () => void;
  onCreateStore?: () => void;
  onCreateNewsletter?: () => void;
  onRename?: (id: string, name: string) => void;
  onDelete?: (id: string) => void;
  menuStyle?: CSSProperties;
  phoneEditor?: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [createMode, setCreateMode] = useState<"page" | "link">("page");
  const [draft, setDraft] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [armedPageId, setArmedPageId] = useState<string | null>(null);

  const hasPages = pages.length > 0;
  const isEditor = mode === "editor";
  const safeHomeHref = safeNavigationHref(homeHref, { allowRelative: true });

  const shouldOpenPage = (id: string, event: MouseEvent<HTMLElement>) => {
    setConfirmDeleteId(null);
    if (!isEditor || !phoneEditor) return true;
    if (armedPageId !== id) {
      event.preventDefault();
      setArmedPageId(id);
      return false;
    }
    setArmedPageId(null);
    return true;
  };

  const commitCreate = () => {
    const v = draft.trim();
    setCreating(false);
    setDraft("");
    if (!v || !onCreate) return;
    if (createMode === "link" || isLikelyUrl(v)) {
      const url = normalizeUrl(v);
      if (!isLikelyUrl(url)) return;
      onCreate({ name: hostnameOf(url), url });
    } else {
      onCreate({ name: v });
    }
  };
  const commitRename = (id: string) => {
    const v = renameDraft.trim();
    setRenamingId(null);
    setRenameDraft("");
    if (v && onRename) onRename(id, v);
  };

  return (
    <>
      <div
        className={`no-scrollbar -mx-4 flex items-center overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:justify-center sm:px-0 lg:justify-start ${
          isEditor ? "justify-start" : "justify-center"
        } ${isEditor ? "my-6 gap-1.5 py-2" : "my-4 gap-1 py-1"}`}
      >
        {hasPages &&
          (!isEditor && safeHomeHref ? (
            <a
              href={safeHomeHref}
              onPointerEnter={() => onIntent?.(null)}
              onFocus={() => onIntent?.(null)}
              aria-label="Home page"
              title="Home"
              className={`inline-flex size-6 items-center justify-center rounded-md text-xs transition ${
                activeId === null
                  ? "bg-foreground text-background"
                  : "bg-card text-foreground ring-1 ring-border hover:bg-accent"
              }`}
            >
              <Home className="size-3" />
            </a>
          ) : (
            <button
              type="button"
              onPointerEnter={() => onIntent?.(null)}
              onFocus={() => onIntent?.(null)}
              onClick={() => {
                setConfirmDeleteId(null);
                setArmedPageId(null);
                onSelect(null);
              }}
              aria-label="Home page"
              title="Home"
              className={`inline-flex items-center justify-center rounded-md transition ${
                isEditor ? "size-7 text-sm" : "size-6 text-xs"
              } ${
                activeId === null
                  ? "bg-foreground text-background"
                  : "bg-card text-foreground ring-1 ring-border hover:bg-accent"
              }`}
            >
              <Home className="size-3" />
            </button>
          ))}
        {pages.map((p) => {
          const isActive = activeId === p.id;
          const safePageUrl = safeNavigationHref(p.url);
          const safePageHref = safeNavigationHref(p.href, { allowRelative: true });
          const isLink = Boolean(safePageUrl);

          if (renamingId === p.id) {
            return (
              <span
                key={p.id}
                className="inline-flex h-7 items-center rounded-md bg-card px-2 ring-1 ring-border"
              >
                <input
                  autoFocus
                  value={renameDraft}
                  maxLength={40}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={() => commitRename(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(p.id);
                    if (e.key === "Escape") {
                      setRenamingId(null);
                      setRenameDraft("");
                    }
                  }}
                  className="w-28 bg-transparent text-center text-xs outline-none"
                />
              </span>
            );
          }

          const tileBase = `inline-flex items-center justify-center rounded-md text-center transition ${
            isEditor ? "h-7 text-xs" : "h-6 text-[11px]"
          }`;

          const tileButton = isLink ? (
            <a
              href={safePageUrl!}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => shouldOpenPage(p.id, event)}
              aria-expanded={phoneEditor ? armedPageId === p.id : undefined}
              title={`${p.name}: opens in a new tab`}
              className={`${tileBase} gap-1 bg-card px-1.5 text-foreground ring-1 ring-border hover:bg-accent`}
            >
              <img
                src={faviconFor(safePageUrl!)}
                alt=""
                width={14}
                height={14}
                className="size-3.5 rounded-sm"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
                }}
              />
            </a>
          ) : safePageHref ? (
            <a
              href={safePageHref}
              target={isEditor ? "_blank" : undefined}
              rel={isEditor ? "noopener noreferrer" : undefined}
              onClick={(event) => shouldOpenPage(p.id, event)}
              aria-expanded={phoneEditor ? armedPageId === p.id : undefined}
              title={isEditor ? `${p.name}: opens the visitor page in a new tab` : p.name}
              className={`${tileBase} bg-card px-2 text-foreground ring-1 ring-border hover:bg-accent`}
            >
              {p.name}
            </a>
          ) : (
            <button
              type="button"
              onPointerEnter={() => onIntent?.(p.id)}
              onFocus={() => onIntent?.(p.id)}
              onClick={(event) => {
                if (!shouldOpenPage(p.id, event)) return;
                onSelect(p.id);
              }}
              aria-expanded={phoneEditor ? armedPageId === p.id : undefined}
              className={`${tileBase} px-2 ${
                isActive
                  ? "bg-foreground text-background"
                  : "bg-card text-foreground ring-1 ring-border hover:bg-accent"
              }`}
            >
              {p.name}
            </button>
          );

          return (
            <span key={p.id} className="group relative inline-flex">
              {tileButton}
              {isEditor && (!phoneEditor || armedPageId === p.id) && (
                <>
                  <button
                    type="button"
                    aria-label="Delete page"
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      if (confirmDeleteId === p.id) {
                        setConfirmDeleteId(null);
                        setArmedPageId(null);
                        onDelete?.(p.id);
                        return;
                      }
                      setConfirmDeleteId(p.id);
                    }}
                    className={`absolute -left-1.5 -top-1.5 z-10 inline-flex h-5 min-w-5 items-center justify-center rounded-sm px-1 text-[10px] leading-none shadow-sm ring-1 transition ${
                      confirmDeleteId === p.id
                        ? "bg-destructive text-destructive-foreground ring-destructive opacity-100"
                        : phoneEditor
                          ? "bg-card text-muted-foreground ring-border opacity-100 hover:bg-accent"
                          : "bg-card text-muted-foreground ring-border opacity-0 hover:bg-accent group-hover:opacity-100 group-focus-within:opacity-100"
                    }`}
                  >
                    {confirmDeleteId === p.id ? "OK" : <Trash2 className="size-3" />}
                  </button>
                  <button
                    type="button"
                    aria-label="Rename page"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenamingId(p.id);
                      setRenameDraft(p.name);
                      setConfirmDeleteId(null);
                      setArmedPageId(null);
                    }}
                    className="absolute -right-1.5 -top-1.5 z-10 inline-flex size-5 items-center justify-center rounded-sm bg-card text-muted-foreground opacity-100 shadow-sm ring-1 ring-border transition hover:bg-accent sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                  >
                    <Pencil className="size-3" />
                  </button>
                </>
              )}
            </span>
          );
        })}

        {isEditor && creating && (
          <span className="inline-flex h-7 items-center rounded-md bg-card px-2 ring-1 ring-border">
            <input
              autoFocus
              value={draft}
              maxLength={2048}
              placeholder={createMode === "link" ? "Paste a URL" : "Page name"}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitCreate}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitCreate();
                if (e.key === "Escape") {
                  setCreating(false);
                  setDraft("");
                }
              }}
              className="w-40 bg-transparent text-center text-xs outline-none placeholder:text-muted-foreground"
            />
          </span>
        )}

        {isEditor && !creating && (
          <Popover open={createMenuOpen} onOpenChange={setCreateMenuOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                onClick={() => {
                  setConfirmDeleteId(null);
                  setArmedPageId(null);
                }}
                aria-label="Add page, link, calendar, social stats or newsletter"
                title="Add page, link, calendar, social stats or newsletter"
                className="inline-flex size-7 items-center justify-center rounded-md bg-card text-foreground ring-1 ring-border transition hover:bg-accent"
              >
                <Plus className="size-3" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              side="bottom"
              sideOffset={8}
              style={menuStyle}
              className="z-[60] w-48 rounded-2xl border-border bg-card p-1.5 text-foreground"
            >
              <button
                type="button"
                onClick={() => {
                  setCreateMode("page");
                  setCreateMenuOpen(false);
                  setCreating(true);
                }}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium hover:bg-accent"
              >
                <FileText className="size-3.5" /> New page
              </button>
              <button
                type="button"
                onClick={() => {
                  setCreateMode("link");
                  setCreateMenuOpen(false);
                  setCreating(true);
                }}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium hover:bg-accent"
              >
                <Link2 className="size-3.5" /> External link
              </button>
              {onCreateCalendar && (
                <button
                  type="button"
                  disabled={pages.some((page) => page.system === "calendar")}
                  onClick={() => {
                    setCreateMenuOpen(false);
                    onCreateCalendar();
                  }}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium hover:bg-accent disabled:cursor-default disabled:opacity-45"
                >
                  <CalendarDays className="size-3.5" />
                  {pages.some((page) => page.system === "calendar")
                    ? "Calendar added"
                    : "Calendar page"}
                </button>
              )}
              {onCreateInsights && (
                <button
                  type="button"
                  disabled={pages.some((page) => page.system === "insights")}
                  onClick={() => {
                    setCreateMenuOpen(false);
                    onCreateInsights();
                  }}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium hover:bg-accent disabled:cursor-default disabled:opacity-45"
                >
                  <BarChart3 className="size-3.5" />
                  {pages.some((page) => page.system === "insights")
                    ? "Social stats added"
                    : "Social stats page"}
                </button>
              )}
              {onCreateStore && (
                <button
                  type="button"
                  disabled={pages.some((page) => page.system === "store")}
                  onClick={() => {
                    setCreateMenuOpen(false);
                    onCreateStore();
                  }}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium hover:bg-accent disabled:cursor-default disabled:opacity-45"
                >
                  <ShoppingBag className="size-3.5" />
                  {pages.some((page) => page.system === "store") ? "Store added" : "Store page"}
                </button>
              )}
              {onCreateNewsletter && (
                <button
                  type="button"
                  disabled={pages.some((page) => page.system === "newsletter")}
                  onClick={() => {
                    setCreateMenuOpen(false);
                    onCreateNewsletter();
                  }}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium hover:bg-accent disabled:cursor-default disabled:opacity-45"
                >
                  <Newspaper className="size-3.5" />
                  {pages.some((page) => page.system === "newsletter")
                    ? "Newsletter added"
                    : "Newsletter page"}
                </button>
              )}
            </PopoverContent>
          </Popover>
        )}
      </div>
    </>
  );
}
