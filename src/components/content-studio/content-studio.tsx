import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Clapperboard,
  Compass,
  Download,
  FolderOpen,
  Images,
  KeyRound,
  Save,
} from "lucide-react";
import { CreatorIntelligencePanel } from "@/components/content/CreatorIntelligencePanel";
import { Button } from "@/components/ui/button";
import {
  CAROUSEL_STARTERS,
  REEL_STARTERS,
  studioDocumentSchema,
  studioMediaReferences,
  studioStarter,
  type StudioDocument,
  type StudioEntry,
} from "@/lib/content-studio";
import {
  deleteContentStudioEntry,
  listContentStudioMedia,
  loadContentStudio,
  openStudioSchedulerDraft,
  saveContentStudioEntry,
} from "@/lib/content-studio.functions";
import { DEFAULT_AGENT_BRANDING, contrastRatio } from "@/lib/content-agent-branding";
import { carouselCopyIssues } from "@/lib/content-carousel";
import { checkContentMediaUpload, registerContentMediaUpload } from "@/lib/content-media.functions";
import { uploadFileResult } from "@/lib/upload";
import { reviewHeyGenGeneration } from "@/lib/external-tools.functions";
import { optimizeImageUpload } from "@/lib/image-upload";
import { StudioCarouselEditor } from "./studio-carousel";
import { StudioCarouselBackground } from "./studio-carousel-background";
import { StudioReelEditor } from "./studio-reel";
import { StudioAvatarPanel } from "./studio-avatar";
import { useStudioAvatarJobs } from "@/hooks/use-studio-avatar-jobs";
import { StudioGeneration } from "./studio-generation";
import { StudioInput, StudioLabel, StudioMediaPicker, StudioSelect } from "./studio-controls";

type StudioSource = {
  format: StudioDocument["format"];
  title: string;
  text: string;
  url?: string | null;
};
type LocalExport = {
  files: File[];
  signature: string;
  requestId: string;
  uploads: Map<string, { key: string; id?: string }>;
};

function seedFromSource(source: StudioSource) {
  const entry = studioStarter(
    source.format,
    source.format === "carousel" ? "editorial" : "jump-cut",
    DEFAULT_AGENT_BRANDING,
  );
  const title = source.title.trim() || entry.title;
  const copy = source.text.trim();
  let sourceUrl: string | undefined;
  if (
    source.url &&
    /^https?:\/\//i.test(source.url) &&
    URL.canParse(source.url) &&
    source.url.length <= 2000
  )
    sourceUrl = source.url;
  const document = { ...entry.document, sourceUrl };
  if (document.format === "carousel") {
    document.slides[0] = {
      heading: title.slice(0, 90),
      body: copy.slice(0, 360) || document.slides[0].body,
    };
  } else {
    document.scenes[0] = {
      ...document.scenes[0],
      title: title.slice(0, 64),
      caption: copy.slice(0, 160),
    };
  }
  return { ...entry, title: title.slice(0, 120), document };
}

function filename(title: string) {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "bento-project"
  );
}

function download(file: File) {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function ContentStudio({
  workspaceId,
  initialSource,
}: {
  workspaceId: string;
  initialSource?: StudioSource | null;
}) {
  return (
    <StudioWorkspace workspaceId={workspaceId} initialSource={initialSource} key={workspaceId} />
  );
}

function StudioWorkspace({
  workspaceId,
  initialSource,
}: {
  workspaceId: string;
  initialSource?: StudioSource | null;
}) {
  const [editing, setEditing] = useState<StudioEntry | null>(() =>
    initialSource ? seedFromSource(initialSource) : null,
  );
  const [format, setFormat] = useState<StudioDocument["format"]>(
    initialSource?.format ?? "carousel",
  );
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [localExport, setLocalExport] = useState<LocalExport | null>(null);
  const [showBrand, setShowBrand] = useState(false);
  const [presetName, setPresetName] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const renderController = useRef<AbortController | null>(null);
  useEffect(() => () => renderController.current?.abort(), []);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const studioKey = ["content-studio", workspaceId];
  const query = useQuery({
    queryKey: studioKey,
    queryFn: () => loadContentStudio({ data: { workspaceId } }),
    retry: false,
  });
  const selectedIds = useMemo(
    () =>
      [
        ...new Set(
          editing
            ? studioMediaReferences(editing.document).filter((id): id is string => Boolean(id))
            : [],
        ),
      ].sort(),
    [editing],
  );
  const mediaKey = ["content-studio-media", workspaceId];
  const media = useInfiniteQuery({
    queryKey: [...mediaKey, selectedIds],
    enabled: Boolean(editing),
    initialPageParam: 0,
    retry: false,
    queryFn: ({ pageParam }) =>
      listContentStudioMedia({ data: { workspaceId, page: pageParam, selectedIds } }),
    getNextPageParam: (last, pages) =>
      last.hasMore && pages.length <= 100 ? pages.length : undefined,
  });
  const assets = useMemo(
    () => [
      ...new Map(
        (media.data?.pages.flatMap((page) => page.assets) || []).map((asset) => [asset.id, asset]),
      ).values(),
    ],
    [media.data],
  );
  const mediaById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const { jobs, avatarUrls } = useStudioAvatarJobs(
    workspaceId,
    editing?.document.format === "reel" ? editing.document : null,
  );
  const validExport =
    localExport &&
    editing &&
    localExport.signature === JSON.stringify([editing.title, editing.document])
      ? localExport
      : null;

  const showError = (failure: unknown) =>
    setError(failure instanceof Error ? failure.message : "This action could not be completed.");
  const run = async (label: string, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (failure) {
      showError(failure);
    } finally {
      setBusy("");
    }
  };

  const open = (entry: StudioEntry | null) => {
    setEditing(entry);
    setError("");
    setNotice("");
    setShowBrand(false);
    setConfirmDelete(false);
    setPresetName(null);
    setLocalExport(null);
  };
  const update = (document: StudioDocument) =>
    setEditing((current) => (current ? { ...current, document } : null));

  const persist = async (entry: StudioEntry) => {
    const saved = await saveContentStudioEntry({ data: { workspaceId, ...entry } });
    queryClient.setQueryData(studioKey, (current: typeof query.data) =>
      current
        ? {
            ...current,
            entries: [saved, ...current.entries.filter((item) => item.id !== saved.id)],
          }
        : current,
    );
    return saved;
  };
  const save = async (entry: StudioEntry) => {
    setEditing(await persist(entry));
    setNotice("Saved.");
  };

  const exportCurrent = async (entry: StudioEntry) =>
    run("Preparing export…", async () => {
      const document = studioDocumentSchema.parse(entry.document);
      const signature = JSON.stringify([entry.title, entry.document]);
      const name = filename(entry.title);
      const finishExport = (files: File[]) =>
        setLocalExport({ files, signature, requestId: crypto.randomUUID(), uploads: new Map() });
      if (document.format === "carousel") {
        const issues = carouselCopyIssues(document.slides);
        if (issues.length) throw new Error(issues[0]);
        const { buildStudioCarouselSlide, carouselSvgToJpeg } =
          await import("@/lib/content-studio-carousel");
        const files: File[] = [];
        for (const index of document.slides.keys()) {
          setBusy(`Rendering slide ${index + 1} of ${document.slides.length}…`);
          const svg = await buildStudioCarouselSlide(document, index, mediaById);
          files.push(
            new File([await carouselSvgToJpeg(svg)], `${name}-${index + 1}.jpg`, {
              type: "image/jpeg",
            }),
          );
        }
        finishExport(files);
      } else {
        const controller = new AbortController();
        renderController.current = controller;
        try {
          const { renderStudioReel } = await import("@/lib/content-studio-reel-render");
          const clipIds = [
            ...new Set(
              document.scenes.flatMap((scene) =>
                scene.kind === "avatar" && !scene.mediaId && scene.avatarJobId
                  ? [scene.avatarJobId]
                  : [],
              ),
            ),
          ];
          const clips = await Promise.all(
            clipIds.map((jobId) => reviewHeyGenGeneration({ data: { jobId } })),
          );
          const urls = new Map(
            clips.flatMap((clip) =>
              clip.status === "ready" && clip.assetUrl
                ? [[clip.jobId, clip.assetUrl] as const]
                : [],
            ),
          );
          if (urls.size !== clipIds.length)
            throw new Error("Finish the avatar generation before exporting.");
          controller.signal.throwIfAborted();
          const file = await renderStudioReel(
            document,
            { media: mediaById, avatarUrls: urls },
            (progress) => {
              setBusy(`Rendering MP4 · ${Math.floor(progress * 100)}%`);
            },
            controller.signal,
          );
          finishExport([new File([file], `${name}.mp4`, { type: "video/mp4" })]);
        } finally {
          renderController.current = null;
        }
      }
      setNotice("Export ready.");
    });

  async function uploadMediaFile(file: File) {
    const kind = file.type.startsWith("video/") ? "video" : "image";
    const prepared = kind === "image" ? await optimizeImageUpload(file, "image") : file;
    await checkContentMediaUpload({ data: { bytes: prepared.size, kind } });
    const uploaded = await uploadFileResult(prepared, kind, { optimize: false });
    return uploaded.key;
  }

  async function saveExportToMedia(exported: LocalExport) {
    const ids: string[] = [];
    for (const file of exported.files) {
      let uploaded = exported.uploads.get(file.name);
      if (!uploaded) {
        uploaded = { key: await uploadMediaFile(file) };
        exported.uploads.set(file.name, uploaded);
      }
      if (!uploaded.id) {
        const item = await registerContentMediaUpload({
          data: { key: uploaded.key, name: file.name },
        });
        uploaded.id = item.id;
      }
      ids.push(uploaded.id);
    }
    await queryClient.invalidateQueries({ queryKey: mediaKey });
    return ids;
  }

  const upload = (file: File) =>
    void run("Uploading media…", async () => {
      const key = await uploadMediaFile(file);
      await registerContentMediaUpload({ data: { key, name: file.name } });
      await queryClient.invalidateQueries({ queryKey: mediaKey });
      setNotice("Added to Media.");
    });

  const hasProjects = query.data?.entries.some((entry) => entry.kind === "project");

  if (query.isPending && !editing)
    return (
      <p role="status" className="studio-shell">
        Loading Studio…
      </p>
    );
  if (query.isError && !editing) {
    return (
      <div className="studio-shell">
        <div className="studio-surface space-y-4">
          <p role="alert">Your projects could not load.</p>
          <Button type="button" variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <section
      className="studio-shell"
      aria-label="Content Studio"
      data-view={editing ? "editor" : "library"}
    >
      {editing ? (
        <>
          <div className="studio-toolbar studio-top studio-surface">
            <button
              type="button"
              className="content-action"
              disabled={Boolean(busy)}
              onClick={() => open(null)}
            >
              <ArrowLeft size={16} /> Projects
            </button>
            <div className="studio-actions">
              <button
                type="button"
                className="content-action"
                disabled={Boolean(busy) || !editing.title.trim()}
                onClick={() => setPresetName(editing.title)}
              >
                {editing.kind === "preset" ? "Duplicate preset" : "Save as preset"}
              </button>
              <button
                type="button"
                className="content-action"
                disabled={Boolean(busy)}
                onClick={() => setShowBrand(!showBrand)}
                aria-expanded={showBrand}
              >
                Brand
              </button>
              <button
                type="button"
                className="content-action content-action-primary"
                disabled={Boolean(busy) || !editing.title.trim()}
                onClick={() => void run("Saving…", () => save(editing))}
              >
                <Save size={16} /> Save {editing.kind}
              </button>
            </div>
          </div>
          <StudioLabel label={editing.kind === "preset" ? "Preset name" : "Project name"}>
            <StudioInput
              value={editing.title}
              maxLength={120}
              disabled={Boolean(busy)}
              onChange={(event) => setEditing({ ...editing, title: event.target.value })}
            />
          </StudioLabel>
          {editing.document.sourceUrl && (
            <a
              href={editing.document.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="studio-source"
            >
              Source post <ArrowUpRight size={14} />
            </a>
          )}
          {showBrand && (
            <fieldset className="studio-brand" disabled={Boolean(busy)}>
              <legend>Brand colors</legend>
              <div className="studio-brand-colors">
                {(
                  [
                    ["accentColor", "Accent"],
                    ["backgroundColor", "Background"],
                    ["textColor", "Text"],
                  ] as const
                ).map(([key, label]) => (
                  <StudioLabel label={label} key={key}>
                    <StudioInput
                      type="color"
                      value={editing.document.brand[key]}
                      onChange={(event) =>
                        update({
                          ...editing.document,
                          brand: { ...editing.document.brand, [key]: event.target.value },
                        })
                      }
                    />
                  </StudioLabel>
                ))}
                {query.data && (
                  <button
                    className="content-action"
                    type="button"
                    onClick={() => update({ ...editing.document, brand: query.data!.brand })}
                  >
                    Use workspace brand
                  </button>
                )}
              </div>
              {contrastRatio(
                editing.document.brand.textColor,
                editing.document.brand.backgroundColor,
              ) < 4.5 && (
                <p role="status" className="studio-muted">
                  Choose text and background colors with at least 4.5:1 contrast.
                </p>
              )}
              {editing.document.format === "carousel" && (
                <div className="studio-dual">
                  <StudioLabel label="Cover style">
                    <StudioSelect
                      value={editing.document.brand.coverStyle}
                      onChange={(event) =>
                        update({
                          ...editing.document,
                          brand: {
                            ...editing.document.brand,
                            coverStyle: event.target.value === "portrait" ? "portrait" : "text",
                          },
                        })
                      }
                    >
                      <option value="text">Text</option>
                      <option value="portrait">Portrait</option>
                    </StudioSelect>
                  </StudioLabel>
                  {editing.document.brand.coverStyle === "portrait" && (
                    <StudioMediaPicker
                      assets={assets}
                      value={editing.document.brand.heroPhotoId}
                      kind="image"
                      label="Cover portrait"
                      onChange={(id) =>
                        update({
                          ...editing.document,
                          brand: { ...editing.document.brand, heroPhotoId: id },
                        })
                      }
                    />
                  )}
                </div>
              )}
            </fieldset>
          )}
          {presetName !== null && (
            <div className="studio-toolbar studio-preset-form">
              <StudioLabel label="New preset name">
                <StudioInput
                  value={presetName}
                  disabled={Boolean(busy)}
                  maxLength={120}
                  onChange={(event) => setPresetName(event.target.value)}
                />
              </StudioLabel>
              <div className="studio-actions">
                <button
                  type="button"
                  className="content-action"
                  disabled={Boolean(busy)}
                  onClick={() => setPresetName(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="content-action content-action-primary"
                  disabled={Boolean(busy) || !presetName.trim()}
                  onClick={() =>
                    void run("Saving preset…", async () => {
                      await persist({
                        ...editing,
                        kind: "preset",
                        id: crypto.randomUUID(),
                        title: presetName,
                        revision: 0,
                      });
                      setPresetName(null);
                      setNotice("Preset saved.");
                    })
                  }
                >
                  Save preset
                </button>
              </div>
            </div>
          )}
          <fieldset disabled={Boolean(busy)} className="studio-editor">
            {editing.kind === "project" && (
              <div className="studio-generation">
                <StudioGeneration
                  key={editing.id}
                  workspaceId={workspaceId}
                  title={editing.title}
                  document={editing.document}
                  onApply={(result) =>
                    setEditing((current) =>
                      current?.id === editing.id ? { ...current, ...result } : current,
                    )
                  }
                />
              </div>
            )}
            {media.error && (
              <p role="status" className="studio-muted">
                Media library could not be loaded.{" "}
                <button
                  type="button"
                  className="content-action"
                  onClick={() => void media.refetch()}
                >
                  Retry
                </button>
              </p>
            )}
            {editing.document.format === "carousel" ? (
              <StudioCarouselEditor
                key={editing.id}
                document={editing.document}
                onChange={update}
                assets={assets}
                onMore={
                  media.hasNextPage && !media.isFetchingNextPage
                    ? () => void media.fetchNextPage()
                    : undefined
                }
                onUpload={upload}
              />
            ) : (
              <StudioReelEditor
                key={editing.id}
                document={editing.document}
                avatarUrls={avatarUrls}
                onChange={update}
                assets={assets}
                onMore={
                  media.hasNextPage && !media.isFetchingNextPage
                    ? () => void media.fetchNextPage()
                    : undefined
                }
                onUpload={upload}
              />
            )}
          </fieldset>
          {editing.document.format === "reel" && (
            <StudioAvatarPanel
              workspaceId={workspaceId}
              document={editing.document}
              jobs={jobs}
              onChange={update}
              disabled={Boolean(busy)}
              onSaveUpdate={async (document) => {
                const next = { ...editing, document };
                setEditing(next);
                await save(next);
              }}
              onError={showError}
              onBusyChange={setBusy}
            />
          )}
          {editing.kind === "project" && (
            <div className="studio-toolbar studio-export studio-surface">
              <div className="studio-export-intro">
                <h2>Export</h2>
                <p className="studio-muted">
                  Prepare files to download or open as a draft in Scheduler.
                </p>
              </div>
              <div className="studio-actions">
                <button
                  type="button"
                  className="content-action content-action-primary"
                  disabled={Boolean(busy)}
                  onClick={() => void exportCurrent(editing)}
                >
                  <Download size={16} />{" "}
                  {editing.document.format === "carousel" ? "Export slides" : "Export MP4"}
                </button>
                {renderController.current && (
                  <button
                    type="button"
                    className="content-action"
                    onClick={() => renderController.current?.abort(new Error("Render canceled."))}
                  >
                    Cancel render
                  </button>
                )}
              </div>
              {editing.revision > 0 &&
                query.data?.entries.some(
                  (entry) =>
                    entry.id === editing.id &&
                    entry.revision === editing.revision &&
                    entry.title === editing.title &&
                    JSON.stringify(entry.document) === JSON.stringify(editing.document),
                ) && (
                  <StudioCarouselBackground
                    workspaceId={workspaceId}
                    entryId={editing.id}
                    revision={editing.revision}
                    title={editing.title}
                    format={editing.document.format}
                    requiresPhoto={
                      editing.document.format === "carousel" &&
                      (editing.document.brand.coverStyle === "portrait" ||
                        studioMediaReferences(editing.document).some(Boolean))
                    }
                  />
                )}
              {validExport && (
                <div className="studio-actions" aria-label="Exported files">
                  {validExport.files.map((file, index) => (
                    <button
                      key={file.name}
                      type="button"
                      className="content-action"
                      onClick={() => download(file)}
                    >
                      {validExport.files.length === 1
                        ? "Download MP4"
                        : `Download slide ${index + 1}`}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="content-action"
                    disabled={
                      Boolean(busy) ||
                      validExport.files.every((file) => validExport.uploads.get(file.name)?.id)
                    }
                    onClick={() =>
                      void run("Saving export to Media…", async () => {
                        await saveExportToMedia(validExport);
                        setNotice("Export saved to Media.");
                      })
                    }
                  >
                    Save to Media
                  </button>
                  <button
                    type="button"
                    className="content-action"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void run("Preparing Scheduler draft…", async () => {
                        const saved = await persist(editing);
                        setEditing(saved);
                        const mediaIds = await saveExportToMedia(validExport);
                        const { postId } = await openStudioSchedulerDraft({
                          data: {
                            workspaceId,
                            title: saved.title,
                            requestId: validExport.requestId,
                            mediaIds,
                          },
                        });
                        void queryClient.invalidateQueries({ queryKey: ["social-scheduler"] });
                        await navigate({ to: "/post-scheduler", search: { postId } });
                      })
                    }
                  >
                    Open draft in Scheduler
                  </button>
                </div>
              )}
            </div>
          )}
          {editing.revision > 0 && (
            <div className="studio-actions">
              {confirmDelete && <span className="studio-muted">Delete this {editing.kind}?</span>}
              {confirmDelete && (
                <button
                  type="button"
                  className="content-action"
                  disabled={Boolean(busy)}
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </button>
              )}
              <button
                type="button"
                className="content-action studio-delete"
                disabled={Boolean(busy)}
                onClick={() => {
                  if (!confirmDelete) {
                    setConfirmDelete(true);
                    return;
                  }
                  void run("Deleting…", async () => {
                    await deleteContentStudioEntry({
                      data: { workspaceId, id: editing.id, revision: editing.revision },
                    });
                    queryClient.setQueryData(studioKey, (current: typeof query.data) =>
                      current
                        ? {
                            ...current,
                            entries: current.entries.filter((item) => item.id !== editing.id),
                          }
                        : current,
                    );
                    open(null);
                  });
                }}
              >
                {confirmDelete ? "Confirm delete" : `Delete ${editing.kind}`}
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <header className="studio-welcome studio-surface">
            <div>
              <h2 className="font-ui-display">Create a carousel or Reel</h2>
              <p className="studio-muted">
                Start with a template and make it yours. Export finished files or open a draft in
                Scheduler.
              </p>
            </div>
            <div className="studio-actions">
              {hasProjects && (
                <Button asChild variant="outline">
                  <a href="#studio-projects">
                    <FolderOpen aria-hidden="true" /> Your projects
                  </a>
                </Button>
              )}
              <Button asChild variant="outline">
                <Link to="/content" search={{ tab: "discover" }}>
                  <Compass aria-hidden="true" /> Start from Discover
                </Link>
              </Button>
              <Button asChild variant="outline">
                <Link to="/settings" search={{ section: "ai-providers" }}>
                  <KeyRound aria-hidden="true" /> AI providers
                </Link>
              </Button>
            </div>
          </header>

          <div className="studio-library">
            <div className="studio-library-main">
              <div className="studio-library-heading">
                <h2>{format === "carousel" ? "Carousel starters" : "Reel editing styles"}</h2>
                <div className="studio-switch" role="group" aria-label="Project format">
                  <button
                    type="button"
                    aria-pressed={format === "carousel"}
                    onClick={() => setFormat("carousel")}
                  >
                    <Images size={16} aria-hidden="true" /> Carousels
                  </button>
                  <button
                    type="button"
                    aria-pressed={format === "reel"}
                    onClick={() => setFormat("reel")}
                  >
                    <Clapperboard size={16} aria-hidden="true" /> Reels
                  </button>
                </div>
              </div>
              <div className="studio-starters">
                {Object.entries(format === "carousel" ? CAROUSEL_STARTERS : REEL_STARTERS).map(
                  ([key, starter], index) => (
                    <button
                      type="button"
                      className="studio-starter"
                      key={key}
                      onClick={() =>
                        open(
                          studioStarter(format, key, query.data?.brand || DEFAULT_AGENT_BRANDING),
                        )
                      }
                    >
                      <span
                        className="studio-starter-art"
                        data-style={index % 3}
                        data-format={format}
                        aria-hidden="true"
                      >
                        <i />
                        <i />
                        <i />
                      </span>
                      <span className="studio-starter-copy">
                        <strong>{starter.name}</strong>
                        <span className="studio-muted">{starter.description}</span>
                      </span>
                    </button>
                  ),
                )}
              </div>
            </div>

            <div className="studio-library-side">
              {(["project", "preset"] as const).map((kind) => {
                const entries =
                  query.data?.entries.filter(
                    (entry) => entry.document.format === format && entry.kind === kind,
                  ) ?? [];
                return (
                  <section
                    className="studio-saved studio-surface"
                    key={kind}
                    id={kind === "project" ? "studio-projects" : undefined}
                  >
                    <h2>{kind === "project" ? "Projects" : "Presets"}</h2>
                    {!entries.length ? (
                      <div className="studio-saved-empty">
                        {kind === "project" && <FolderOpen size={20} aria-hidden="true" />}
                        <p className="studio-muted">
                          {kind === "project"
                            ? hasProjects
                              ? `No saved ${format === "carousel" ? "carousels" : "Reels"} yet.`
                              : "Choose a template to start. Save the project to pick up where you left off."
                            : "Save a project as a preset to reuse its design."}
                        </p>
                      </div>
                    ) : (
                      <ul>
                        {entries.map((entry) => (
                          <li key={entry.id}>
                            <button
                              type="button"
                              className="studio-project-title"
                              onClick={() => open(entry)}
                            >
                              <span>{entry.title}</span>
                              <ArrowRight size={14} aria-hidden="true" />
                            </button>
                            {kind === "preset" && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  open({
                                    ...entry,
                                    kind: "project",
                                    id: crypto.randomUUID(),
                                    revision: 0,
                                  })
                                }
                              >
                                Use preset
                              </Button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })}
              {!hasProjects && (
                <details className="studio-surface">
                  <summary className="cursor-pointer text-sm font-semibold">
                    Make your first project
                  </summary>
                  <ul className="mt-3 list-disc space-y-2 pl-4 text-sm leading-relaxed text-muted-foreground">
                    <li>
                      Choose a template, or open a post in Discover and select Create carousel or
                      Create Reel.
                    </li>
                    <li>
                      Edit the slides or scenes. Choose Generate draft if you want help writing the
                      copy.
                    </li>
                    <li>
                      Save, export, and choose Open draft in Scheduler when you’re ready to
                      schedule.
                    </li>
                  </ul>
                </details>
              )}
              <CreatorIntelligencePanel workspaceId={workspaceId} />
            </div>
          </div>
        </>
      )}
      {busy && (
        <p role="status" className="studio-message">
          {busy}
        </p>
      )}
      {notice && !busy && (
        <p role="status" className="studio-message">
          {notice}
        </p>
      )}
      {(error || query.error) && (
        <p role="alert" className="studio-message studio-error">
          {error || query.error?.message}
        </p>
      )}
    </section>
  );
}
