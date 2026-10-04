import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { ChevronRight, Image, Plus, RefreshCw, Search } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ContentDocument, ContentMarkdown } from "./ContentDocument";
import {
  buildContentStrategy,
  groupBrainItems,
  type BrainItem,
  type BrainItemInput,
  type ContentProfile,
} from "@/lib/content-brain";

export type ContentBrainSource = {
  id: string;
  provider: string;
  handle: string;
  displayName: string;
  status: string;
};
export type ContentBrainPhoto = {
  id: string;
  title: string;
  url: string;
  sourceUrl: string | null;
  provider: string;
  type?: "image" | "video";
  role?: "attachment" | "thumbnail";

  caption?: string;
  tags?: string[];
};
export type ContentBrainSection =
  | "profile"
  | "instruction"
  | "strategy"
  | "story"
  | "library"
  | "file"
  | "photo"
  | "sources"
  | "skill";
type Section = ContentBrainSection;
const sections: Array<[Section, string]> = [
  ["profile", "My Human"],
  ["instruction", "Instructions"],
  ["strategy", "Strategy"],
  ["story", "Stories"],
  ["file", "Files"],
  ["photo", "Photos"],
  ["skill", "Skills"],
  ["library", "Library"],
  ["sources", "Sources"],
];
const providers: Record<string, string> = {
  twitter: "X",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  youtube: "YouTube",
  tiktok: "TikTok",
  notion: "Notion",
  granola: "Granola",
  github: "GitHub",
  slack: "Slack",
  fathom: "Fathom",
  google_calendar: "Google Calendar",
};

export function ContentBrain({
  profile,
  initialSection = "profile",
  initialItemId = null,
  initialPlatform = "twitter",
  onNavigate,
  items,
  sources,
  photos = [],
  indexing,
  onMediaSearch,
  building = false,
  onBuildBrain,
  onSaveProfile,
  onSaveItem,
  onConfirm,
  onLock,
  onDelete,
  onUpload,
}: {
  profile: ContentProfile;
  initialSection?: Section;
  initialItemId?: string | null;
  initialPlatform?: "twitter" | "linkedin";
  onNavigate?: (section: Section, item: string | null, platform: "twitter" | "linkedin") => void;
  items: BrainItem[];
  sources: ContentBrainSource[];
  photos?: ContentBrainPhoto[];
  indexing?: {
    status: string;
    indexedAt: string | null;
    error: string | null;
    sourceCount: number;
    mediaCount: number;
  } | null;
  building?: boolean;
  onMediaSearch?: (query: string) => void;
  onBuildBrain?: () => void | Promise<void>;
  onSaveProfile: (profile: ContentProfile) => void | Promise<void>;
  onSaveItem: (item: BrainItemInput) => void | Promise<void>;
  onConfirm: (id: string) => void | Promise<void>;
  onLock: (id: string, locked: boolean) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
  onUpload: (file: File, kind: "file" | "photo") => void | Promise<void>;
}) {
  const [section, setSection] = useState<Section>(initialSection);
  const [selected, setSelected] = useState<string | null>(initialItemId);
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState<"twitter" | "linkedin">(initialPlatform);
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [mediaFilter, setMediaFilter] = useState<"image" | "video">("image");
  useEffect(() => {
    setSection(initialSection);
    setSelected(initialItemId);
    setPlatform(initialPlatform);
  }, [initialSection, initialItemId, initialPlatform]);
  const selectItem = (id: string | null) => {
    setSelected(id);
    onNavigate?.(section, id, platform);
  };
  const grouped = useMemo(() => groupBrainItems(items), [items]);
  const human = grouped.profile.find((item) => item.title === "My Human");
  const memories = grouped.profile.filter((item) => item.id !== human?.id);
  const visible =
    section === "library"
      ? [...grouped.inspiration, ...grouped.link]
      : section === "sources"
        ? []
        : section === "skill"
          ? grouped.instruction.filter((item) => item.tags?.includes("skill"))
          : section === "instruction"
            ? grouped.instruction.filter((item) => !item.tags?.includes("skill"))
            : grouped[section];
  const filtered = visible.filter((item) =>
    `${item.title} ${item.content}`.toLowerCase().includes(search.toLowerCase()),
  );
  const selectedItem = visible.find((item) => item.id === selected);
  const title = sections.find(([id]) => id === section)?.[1] || "Brain";
  const changeSection = (next: Section) => {
    setSection(next);
    setSelected(null);
    setSearch("");
    onMediaSearch?.("");
    setAdding(false);
    setError("");
    onNavigate?.(next, null, platform);
  };
  const saveText = (
    item: BrainItem | undefined,
    kind: BrainItemInput["kind"],
    title: string,
    content: string,
  ) =>
    onSaveItem({
      ...(item || {}),
      kind,
      title,
      content,
      provenance: "creator",
      status: "confirmed",
      locked: true,
    });
  const add = async () => {
    if (!newContent.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      await onSaveItem({
        kind:
          section === "library"
            ? "inspiration"
            : section === "profile"
              ? "profile"
              : section === "story"
                ? "story"
                : "instruction",
        title: newTitle.trim() || newContent.trim().split("\n")[0].slice(0, 160),
        content: newContent.trim(),
        ...(section === "skill" ? { tags: ["skill"] } : {}),
        provenance: "creator",
        status: "confirmed",
        locked: true,
      });
      setNewTitle("");
      setNewContent("");
      setAdding(false);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save. Your edits are still here.",
      );
    } finally {
      setSaving(false);
    }
  };
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files || []);
    event.currentTarget.value = "";
    for (const file of files)
      await onUpload(file, file.type.startsWith("image/") ? "photo" : "file");
  };
  const photoItems: ContentBrainPhoto[] = [
    ...grouped.photo
      .filter((item) => item.sourceUrl)
      .map((item) => ({
        id: item.id,
        title: item.title,
        url: item.sourceUrl!,
        sourceUrl: null,
        provider: "upload",
      })),
    ...photos,
  ].filter((photo, index, all) => all.findIndex((other) => other.url === photo.url) === index);
  const activePhoto = photoItems.find((photo) => photo.id === selected);
  return (
    <section
      aria-label="Content Brain"
      className="content-workspace grid h-[calc(100dvh-7rem)] lg:h-[calc(100dvh-3.5rem)] min-h-0 grid-rows-[auto_minmax(0,1fr)] md:grid-rows-1 md:grid-cols-[240px_minmax(0,1fr)]"
    >
      <aside className="content-rail min-w-0">
        <nav
          aria-label="Brain sections"
          className="flex overflow-x-auto md:grid md:overflow-visible"
        >
          {sections.map(([id, label], index) => (
            <div key={id} className={`shrink-0 min-w-0 ${index === 3 ? "md:mt-5" : ""}`}>
              <button
                type="button"
                className="content-nav flex items-center gap-2"
                aria-current={section === id ? "page" : undefined}
                onClick={() => changeSection(id)}
              >
                {index >= 3 && <ChevronRight className="hidden size-3 md:block" />} {label}
              </button>
              {section === id && ["story", "file", "library"].includes(id) && (
                <div className="ml-3 mt-1 hidden border-l border-neutral-200 pl-1 md:block">
                  {id === "story" && (
                    <button className="content-nav" onClick={() => selectItem(null)}>
                      Index
                    </button>
                  )}
                  {visible.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="content-nav truncate"
                      aria-current={selected === item.id ? "page" : undefined}
                      onClick={() => {
                        selectItem(item.id);
                        setAdding(false);
                      }}
                    >
                      {item.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>
        {onBuildBrain && (
          <button
            type="button"
            disabled={building}
            onClick={() => void onBuildBrain()}
            className="content-nav mt-5 flex items-center gap-2"
          >
            <RefreshCw className={`size-3 ${building ? "animate-spin" : ""}`} />
            {building ? "Learning from your posts…" : "Refresh from my posts"}
          </button>
        )}
      </aside>
      <div className="min-h-0 min-w-0 overflow-y-auto px-5 py-8 sm:px-8 md:py-10 lg:px-10">
        <div className="mx-auto max-w-[760px]">
          {selected && (
            <button
              type="button"
              onClick={() => selectItem(null)}
              className="mb-5 text-xs text-neutral-500"
            >
              {title} / Back to index
            </button>
          )}
          {indexing && (
            <p
              role="status"
              className={`mb-5 text-xs leading-5 ${indexing.status === "error" ? "text-red-700" : "text-neutral-500"}`}
            >
              {indexing.status === "pending" || indexing.status === "running"
                ? "Learning from your connected posts and indexing media…"
                : indexing.status === "error"
                  ? indexing.error || "Source indexing will retry shortly."
                  : `${indexing.sourceCount} source posts indexed · ${indexing.mediaCount} reusable assets imported`}
            </p>
          )}
          <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-[28px] font-semibold tracking-tight">
              {selectedItem?.title ||
                activePhoto?.title ||
                (section === "strategy" ? `${providers[platform]} Strategy` : title)}
            </h2>
            {section === "strategy" && (
              <div className="flex gap-1" aria-label="Strategy platform">
                {(["twitter", "linkedin"] as const).map((provider) => (
                  <button
                    key={provider}
                    type="button"
                    aria-label={`${providers[provider]} strategy`}
                    aria-pressed={platform === provider}
                    onClick={() => {
                      setPlatform(provider);
                      onNavigate?.("strategy", null, provider);
                    }}
                    className={`rounded-lg px-3 py-2 text-sm ${platform === provider ? "bg-neutral-100" : "text-neutral-500"}`}
                  >
                    {provider === "twitter" ? "𝕏" : "in"}
                  </button>
                ))}
              </div>
            )}
            {["file", "photo"].includes(section) && (
              <label className="content-action cursor-pointer">
                <Plus className="size-4" />
                Upload
                <input
                  type="file"
                  multiple
                  aria-label={`Upload ${section === "photo" ? "photos" : "files"}`}
                  className="sr-only"
                  accept={section === "photo" ? "image/*" : "image/*,.pdf,.txt,.md"}
                  onChange={upload}
                />
              </label>
            )}
          </header>
          {section === "profile" ? (
            <>
              <ContentDocument
                key={human?.id || "human"}
                label="My Human"
                value={human?.content || ""}
                placeholder="Everything Bento should know about you - background, product facts, audience notes, offers, positioning, examples to remember…"
                onSave={(content) => saveText(human, "profile", "My Human", content)}
              />
              <div className="my-10 text-center tracking-[12px] text-neutral-400">···</div>
              <h3 className="text-lg font-semibold">Bento Memories</h3>
              <p className="mt-1 mb-6 text-xs leading-5 text-neutral-500">
                Remembered from your conversations and posts. Edit anything to correct Bento - your
                corrections stick.
              </p>
              {memories.length ? (
                memories.map((item) => (
                  <KnowledgeItem
                    key={item.id}
                    item={item}
                    onSave={(content) => saveText(item, item.kind, item.title, content)}
                    onConfirm={onConfirm}
                    onLock={onLock}
                    onDelete={onDelete}
                  />
                ))
              ) : (
                <p className="text-sm text-neutral-400">
                  No memories yet. Tell Agent about yourself or refresh from your posts.
                </p>
              )}
              <details className="mt-10 border-t border-neutral-100 pt-5">
                <summary className="cursor-pointer text-sm text-neutral-500">
                  Publishing settings
                </summary>
                <ProfileSettings
                  key={JSON.stringify(profile)}
                  profile={profile}
                  onSave={onSaveProfile}
                />
              </details>
            </>
          ) : section === "strategy" ? (
            (() => {
              const item = grouped.strategy.find((candidate) =>
                platform === "twitter"
                  ? /\b(x|twitter)\b/i.test(candidate.title)
                  : /linkedin/i.test(candidate.title),
              );
              return (
                <>
                  <ContentDocument
                    key={`${platform}:${item?.id || "new"}`}
                    label={`${providers[platform]} Strategy`}
                    value={item?.content || buildContentStrategy(platform, profile, items)}
                    onSave={(content) =>
                      saveText(item, "strategy", `${providers[platform]} Strategy`, content)
                    }
                  />
                  <p className="mt-8 text-xs leading-5 text-neutral-500">
                    Your strategy guides Agent and Routines. Refresh from your posts for a
                    source-backed strategy; edits take priority.
                  </p>
                </>
              );
            })()
          ) : section === "sources" ? (
            <>
              <p className="mb-6 text-sm text-neutral-500">
                Accounts and tools Bento uses to understand your work.
              </p>
              {sources.map((source) => (
                <div
                  key={source.id}
                  className="flex items-center justify-between gap-3 border-b border-neutral-100 py-4"
                >
                  <div>
                    <p className="text-sm font-medium">{source.displayName}</p>
                    <p className="mt-1 text-xs text-neutral-500">
                      {providers[source.provider] || source.provider}
                      {source.handle ? ` · @${source.handle}` : ""}
                    </p>
                  </div>
                  <span className="text-xs text-neutral-500">{source.status}</span>
                </div>
              ))}
              <a href="/social-insights" className="content-action mt-5">
                Manage connected accounts
              </a>
            </>
          ) : section === "photo" ? (
            <>
              {activePhoto ? (
                <>
                  {activePhoto.type === "video" ? (
                    <video
                      src={activePhoto.url}
                      controls
                      aria-label={activePhoto.title}
                      className="max-h-[60dvh] w-full rounded-lg"
                    />
                  ) : (
                    <img
                      src={activePhoto.url}
                      alt={activePhoto.title}
                      className="max-h-[60dvh] w-full rounded-lg object-contain"
                    />
                  )}
                  {activePhoto.caption && (
                    <div className="mt-5">
                      <ContentMarkdown text={activePhoto.caption} />
                    </div>
                  )}
                  {activePhoto.tags?.length ? (
                    <p className="mt-3 text-xs text-neutral-500">{activePhoto.tags.join(" · ")}</p>
                  ) : null}
                  <p className="mt-4 text-xs text-neutral-500">
                    {providers[activePhoto.provider] || "Uploaded photo"}
                  </p>
                  {activePhoto.sourceUrl && (
                    <a
                      className="content-action mt-3"
                      href={activePhoto.sourceUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      Original post
                    </a>
                  )}
                </>
              ) : (
                <>
                  <p className="mb-5 text-xs text-neutral-500">
                    {photoItems.filter((photo) => (photo.type || "image") === mediaFilter).length}{" "}
                    {mediaFilter === "image" ? "photos" : "videos"} · Indexed from connected posts
                    and your uploads
                  </p>
                  <div className="mb-4 flex gap-2" aria-label="Media type">
                    {(["image", "video"] as const).map((type) => (
                      <button
                        key={type}
                        type="button"
                        aria-pressed={mediaFilter === type}
                        className="content-action"
                        onClick={() => setMediaFilter(type)}
                      >
                        {type === "image" ? "Photos" : "Videos"}
                      </button>
                    ))}
                  </div>
                  <input
                    className="content-field mb-5"
                    type="search"
                    aria-label="Search photos"
                    placeholder="Search your photos…"
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      onMediaSearch?.(event.target.value);
                    }}
                  />
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-6">
                    {photoItems
                      .filter((photo) => (photo.type || "image") === mediaFilter)
                      .filter((photo) =>
                        onMediaSearch
                          ? true
                          : `${photo.title} ${photo.caption || ""} ${(photo.tags || []).join(" ")} ${photo.provider}`
                              .toLowerCase()
                              .includes(search.toLowerCase()),
                      )
                      .map((photo) => (
                        <button
                          type="button"
                          key={photo.id}
                          onClick={() => selectItem(photo.id)}
                          className="group relative aspect-square overflow-hidden rounded-xl"
                          aria-label={photo.title}
                        >
                          {photo.type === "video" ? (
                            <span className="flex h-full items-center justify-center bg-neutral-100 p-3 text-xs text-neutral-600">
                              ▶ {photo.title}
                            </span>
                          ) : (
                            <img
                              src={photo.url}
                              alt={photo.title}
                              loading="lazy"
                              className="h-full w-full object-cover transition group-hover:scale-105"
                            />
                          )}
                          <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 text-[10px] text-white">
                            {providers[photo.provider] || "Upload"}
                            {photo.role === "thumbnail" ? " cover" : ""}
                          </span>
                        </button>
                      ))}
                  </div>
                  {!photoItems.length && (
                    <p className="mt-5 text-sm text-neutral-500">
                      <Image className="mb-3 size-6" />
                      Upload photos or refresh your connected profiles in{" "}
                      <a href="/social-insights" className="underline">
                        Social Insights
                      </a>
                      .
                    </p>
                  )}
                </>
              )}
            </>
          ) : selectedItem ? (
            <KnowledgeItem
              key={selectedItem.id}
              item={selectedItem}
              showTitle={false}
              onSave={(content) =>
                saveText(selectedItem, selectedItem.kind, selectedItem.title, content)
              }
              onConfirm={onConfirm}
              onLock={onLock}
              onDelete={onDelete}
            />
          ) : (
            <>
              <p className="mb-5 text-sm leading-6 text-neutral-500">
                {section === "instruction"
                  ? "Standing rules Bento applies to every reply. Add a rule, or edit an existing one."
                  : section === "story"
                    ? `${visible.length} stories from your own experience. Open a story to read, correct, and reuse it.`
                    : "Reference material Bento can use when planning and writing."}
              </p>
              {visible.length > 3 && (
                <label className="relative mb-6 block">
                  <Search className="absolute left-3 top-3 size-4 text-neutral-400" />
                  <input
                    type="search"
                    aria-label={`Search ${title.toLowerCase()}`}
                    placeholder={`Search ${title.toLowerCase()}…`}
                    className="content-field pl-9"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
              )}
              {section === "story" ? (
                <div>
                  {[...new Set(filtered.map((item) => item.tags?.[0] || "Stories"))]
                    .sort(
                      (a, b) =>
                        filtered.filter((item) => (item.tags?.[0] || "Stories") === b).length -
                          filtered.filter((item) => (item.tags?.[0] || "Stories") === a).length ||
                        a.localeCompare(b),
                    )
                    .map((topic) => (
                      <section key={topic} className="mb-7">
                        <h3 className="mb-3 text-lg font-semibold">
                          {topic} (
                          {
                            filtered.filter((item) => (item.tags?.[0] || "Stories") === topic)
                              .length
                          }
                          )
                        </h3>
                        <ul className="list-disc space-y-3 pl-5 text-[15px] leading-7">
                          {filtered
                            .filter((item) => (item.tags?.[0] || "Stories") === topic)
                            .map((item) => (
                              <li key={item.id}>
                                <button
                                  type="button"
                                  className="text-left underline decoration-neutral-300 underline-offset-4"
                                  onClick={() => selectItem(item.id)}
                                >
                                  {item.title}
                                </button>
                                <span className="text-neutral-600">
                                  {" "}
                                  - {storyPoint(item.content)}
                                </span>
                                {item.status === "suggested" && (
                                  <div className="mt-1 flex gap-3 text-xs text-neutral-500">
                                    <span>
                                      Suggested from{" "}
                                      {providers[item.sourceRef?.split(":")[0] || ""] || "social"}{" "}
                                      post
                                    </span>
                                    <button
                                      type="button"
                                      aria-label="Confirm story"
                                      onClick={() => void onConfirm(item.id)}
                                    >
                                      Confirm
                                    </button>
                                  </div>
                                )}
                              </li>
                            ))}
                        </ul>
                      </section>
                    ))}
                </div>
              ) : (
                filtered.map((item) => (
                  <KnowledgeItem
                    key={item.id}
                    item={item}
                    onSave={(content) => saveText(item, item.kind, item.title, content)}
                    onConfirm={onConfirm}
                    onLock={onLock}
                    onDelete={onDelete}
                  />
                ))
              )}
              {!filtered.length && (
                <p className="py-6 text-sm text-neutral-400">
                  {visible.length
                    ? "No matching items."
                    : "Nothing here yet. Add a note or refresh from your posts."}
                </p>
              )}
              {!["file"].includes(section) && (
                <div className="mt-7">
                  {!adding ? (
                    <button
                      type="button"
                      className="content-action"
                      onClick={() => setAdding(true)}
                    >
                      <Plus className="size-4" />
                      {section === "instruction"
                        ? "Add instruction"
                        : section === "story"
                          ? "Add story"
                          : section === "skill"
                            ? "New skill"
                            : "Add knowledge"}
                    </button>
                  ) : (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void add();
                      }}
                      className="space-y-3"
                    >
                      {section !== "instruction" && (
                        <input
                          aria-label="Brain item title"
                          className="content-field"
                          value={newTitle}
                          maxLength={160}
                          onChange={(event) => setNewTitle(event.target.value)}
                          placeholder="Title"
                        />
                      )}
                      <textarea
                        autoFocus
                        aria-label="Brain item content"
                        className="content-document-input"
                        value={newContent}
                        maxLength={20_000}
                        onChange={(event) => setNewContent(event.target.value)}
                        placeholder={
                          section === "instruction"
                            ? "Never use emojis. Keep hooks to one line…"
                            : "What should Bento remember?"
                        }
                      />
                      <div className="flex gap-2">
                        <button
                          type="submit"
                          disabled={!newContent.trim() || saving}
                          className="content-action content-action-primary"
                        >
                          {saving ? "Saving…" : "Save to Brain"}
                        </button>
                        <button
                          type="button"
                          className="content-action"
                          onClick={() => setAdding(false)}
                        >
                          Cancel
                        </button>
                      </div>
                      {error && (
                        <p role="alert" className="text-sm text-red-700">
                          {error}
                        </p>
                      )}
                    </form>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function storyPoint(content: string) {
  return (
    content.match(/(?:^|\n)(?:[-*]\s*)?(?:\*\*)?Point:(?:\*\*)?\s*([^\n]+)/i)?.[1] ||
    content
      .split("\n")
      .find((line) => line.trim())
      ?.slice(0, 220) ||
    ""
  );
}
function KnowledgeItem({
  item,
  showTitle = true,
  onSave,
  ...actions
}: {
  item: BrainItem;
  showTitle?: boolean;
  onSave: (content: string) => void | Promise<void>;
  onConfirm: (id: string) => void | Promise<void>;
  onLock: (id: string, locked: boolean) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
}) {
  return (
    <article className="mb-7 border-b border-neutral-100 pb-5">
      {showTitle && <h3 className="mb-2 text-lg font-semibold">{item.title}</h3>}
      <p className="mb-2 text-xs text-neutral-500">
        {item.status === "suggested" ? "Suggested from " : "Saved from "}
        {item.provenance === "social_post"
          ? `${providers[item.sourceRef?.split(":")[0] || ""] || "social"} post`
          : item.provenance === "agent_chat"
            ? "your conversation"
            : "you"}
      </p>
      {item.kind === "file" ? (
        <>
          <ContentMarkdown text={item.content} />
          {item.sourceUrl && (
            <a
              href={item.sourceUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="content-action"
            >
              Open file
            </a>
          )}
        </>
      ) : (
        <ContentDocument label={item.title} value={item.content} onSave={onSave} />
      )}
      {item.sourceUrl && item.kind !== "file" && (
        <a
          href={item.sourceUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-xs text-neutral-500 underline"
        >
          View source
        </a>
      )}
      <ItemActions item={item} {...actions} />
    </article>
  );
}
function ItemActions({
  item,
  onConfirm,
  onLock,
  onDelete,
}: {
  item: BrainItem;
  onConfirm: (id: string) => void | Promise<void>;
  onLock: (id: string, locked: boolean) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
}) {
  const name = item.kind === "story" ? "story" : "Brain item";
  return (
    <div className="mt-3 flex flex-wrap gap-3 text-xs text-neutral-500">
      {item.status === "suggested" && (
        <button
          type="button"
          aria-label={`Confirm ${name}`}
          onClick={() => void onConfirm(item.id)}
        >
          Confirm
        </button>
      )}
      <button
        type="button"
        aria-label={`${item.locked ? "Unlock" : "Lock"} ${name}`}
        onClick={() => void onLock(item.id, !item.locked)}
      >
        {item.locked ? "Unlock" : "Lock"}
      </button>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <button type="button" aria-label={`Delete ${name}`}>
            Delete
          </button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this Brain item?</AlertDialogTitle>
            <AlertDialogDescription>
              Bento will stop using this information for future ideas and drafts.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep item</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onDelete(item.id)}>
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
function ProfileSettings({
  profile,
  onSave,
}: {
  profile: ContentProfile;
  onSave: (value: ContentProfile) => void | Promise<void>;
}) {
  const [value, setValue] = useState(profile);
  return (
    <div className="mt-5 space-y-4 text-sm">
      <label className="block">
        Goal
        <select
          className="content-field mt-1"
          value={value.goal}
          onChange={(event) =>
            setValue({ ...value, goal: event.target.value as ContentProfile["goal"] })
          }
        >
          <option value="consistent_publishing">Publish consistently</option>
          <option value="reach_growth">Grow reach</option>
        </select>
      </label>
      <label className="block">
        Niche topics
        <input
          className="content-field mt-1"
          value={value.nicheKeywords.join(", ")}
          onChange={(event) =>
            setValue({
              ...value,
              nicheKeywords: event.target.value
                .split(",")
                .map((word) => word.trim().toLowerCase())
                .filter(Boolean),
            })
          }
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        {(["language", "region", "timezone"] as const).map((field) => (
          <label key={field} className="capitalize">
            {field}
            <input
              className="content-field mt-1"
              value={value[field]}
              onChange={(event) => setValue({ ...value, [field]: event.target.value })}
            />
          </label>
        ))}
      </div>
      <fieldset>
        <legend>Weekly targets</legend>
        <div className="mt-2 grid grid-cols-2 gap-3">
          {["twitter", "linkedin", "instagram", "tiktok", "youtube"].map((provider) => (
            <label key={provider}>
              {providers[provider]}
              <input
                className="content-field mt-1"
                type="number"
                min={0}
                max={21}
                value={value.platformFrequencies[provider] || 0}
                onChange={(event) =>
                  setValue({
                    ...value,
                    platformFrequencies: {
                      ...value.platformFrequencies,
                      [provider]: Number(event.target.value),
                    },
                  })
                }
              />
            </label>
          ))}
        </div>
      </fieldset>
      <button type="button" className="content-action" onClick={() => void onSave(value)}>
        Save settings
      </button>
    </div>
  );
}
