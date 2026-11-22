import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Music2, Search } from "lucide-react";
import { getInstagramAudioCatalog } from "@/lib/instagram-audio.functions";
import type { InstagramAudioTrack } from "@/lib/instagram-audio.server";
import { beginSocialConnection } from "@/lib/social-oauth.functions";
import type { InstagramCatalogAudio, SchedulerMedia } from "@/lib/social-scheduler";
import { micro } from "@/lib/micro-app-ui";

export function InstagramAudioCatalog({
  type,
  video,
  connectionId,
  postId,
  selected,
  onSelect,
}: {
  type: "music" | "original_sound";
  video: SchedulerMedia;
  connectionId: string | null;
  postId: string | null;
  selected: InstagramCatalogAudio | null;
  onSelect: (audio: InstagramCatalogAudio | null) => void;
}) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [choice, setChoice] = useState<InstagramAudioTrack | null>(null);
  const [trackVolume, setTrackVolume] = useState(selected?.trackVolume ?? 80);
  const [originalVolume, setOriginalVolume] = useState(selected?.originalVolume ?? 100);
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const queryClient = useQueryClient();
  const catalog = useQuery({
    queryKey: ["instagram-audio", connectionId, type, query],
    queryFn: () => getInstagramAudioCatalog({ data: { connectionId: connectionId!, type, query } }),
    enabled: Boolean(connectionId && /^[a-f\d-]{36}$/i.test(connectionId)),
    retry: false,
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (!connectionId || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("bento-instagram-audio");
    channel.onmessage = () =>
      void queryClient.invalidateQueries({ queryKey: ["instagram-audio", connectionId] });
    return () => channel.close();
  }, [connectionId, queryClient]);

  async function connect() {
    if (!connectionId) return;
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    setConnecting(true);
    setConnectionError("");
    try {
      const { url } = await beginSocialConnection({
        data: {
          provider: "facebook",
          instagramAudioConnectionId: connectionId,
          postId: postId || undefined,
        },
      });
      if (popup) popup.location.href = url;
      else window.location.assign(url);
    } catch (error) {
      popup?.close();
      setConnectionError(
        error instanceof Error ? error.message : "Instagram audio could not connect.",
      );
    } finally {
      setConnecting(false);
    }
  }

  if (!connectionId)
    return (
      <p className="rounded-xl border border-border p-4 text-sm text-muted-foreground">
        Select one Instagram account to browse its audio catalog.
      </p>
    );
  if (catalog.isFetching && !catalog.data && !catalog.isError)
    return (
      <p className="p-4 text-sm text-muted-foreground" role="status">
        Loading Instagram audio…
      </p>
    );
  if (catalog.isError || !catalog.data?.connected) {
    return (
      <div className="space-y-3 rounded-xl border border-border p-4">
        <p className="text-sm text-muted-foreground">
          Connect the Facebook Page linked to this Instagram account to browse approved tracks.
        </p>
        {catalog.isError && (
          <p role="alert" className="text-sm text-destructive">
            {catalog.error.message}
          </p>
        )}
        {connectionError && (
          <p role="alert" className="text-sm text-destructive">
            {connectionError}
          </p>
        )}
        <button
          type="button"
          className={micro.btnPrimary}
          disabled={connecting}
          onClick={() => void connect()}
        >
          {connecting ? "Connecting…" : "Connect with Facebook"}
        </button>
      </div>
    );
  }
  const selectedId = choice?.id || selected?.audioId;
  const active = choice || catalog.data.tracks.find((track) => track.id === selectedId);

  return (
    <div className="space-y-3">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(search.trim());
        }}
      >
        <input
          aria-label="Search Instagram audio"
          value={search}
          maxLength={100}
          placeholder="Search audio or artists"
          className={micro.input}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
        <button type="submit" className={micro.btnSoft} aria-label="Search">
          <Search className="size-4" />
        </button>
      </form>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{query ? "Search results" : "Trending"}</h3>
        {query && (
          <button
            type="button"
            className="text-xs font-semibold text-primary"
            onClick={() => {
              setQuery("");
              setSearch("");
            }}
          >
            Clear search
          </button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Instagram adds the selected track when publishing. The video preview keeps its original
        audio.
      </p>
      <div className="max-h-56 space-y-1 overflow-y-auto" aria-label="Instagram audio tracks">
        {catalog.data.tracks.map((track) => (
          <button
            key={track.id}
            type="button"
            aria-pressed={selectedId === track.id}
            onClick={() => setChoice(track)}
            className="flex w-full items-center gap-3 rounded-xl border border-transparent p-2 text-left hover:bg-muted/60 aria-pressed:border-primary/30 aria-pressed:bg-primary/10"
          >
            {track.artworkUrl ? (
              <img
                className="size-9 rounded-lg object-cover"
                loading="lazy"
                src={track.artworkUrl}
                alt=""
              />
            ) : (
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                <Music2 className="size-4" />
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{track.title}</span>
              {track.creator && (
                <span className="block truncate text-xs text-muted-foreground">
                  {track.creator}
                </span>
              )}
            </span>
            {track.durationMs !== null && (
              <span className="text-xs tabular-nums text-muted-foreground">
                {Math.round(track.durationMs / 1000)}s
              </span>
            )}
          </button>
        ))}
        {catalog.data.tracks.length === 0 && (
          <p className="p-2 text-sm text-muted-foreground">No eligible audio found.</p>
        )}
      </div>
      {selectedId && (
        <div className="space-y-3 rounded-xl border border-border p-3">
          <p className="text-sm font-semibold">{active?.title || selected?.title}</p>
          {active?.previewUrl ? (
            <audio
              key={active.id}
              src={active.previewUrl}
              controls
              preload="none"
              className="w-full"
              aria-label="Track preview"
            />
          ) : (
            active?.instagramUrl && (
              <a
                className={micro.btnSoft}
                href={active.instagramUrl}
                target="_blank"
                rel="noreferrer"
              >
                Preview on Instagram <ExternalLink className="size-3" />
              </a>
            )
          )}
          <label className="block text-sm">
            <span className="flex justify-between">
              Music <span>{trackVolume}%</span>
            </span>
            <input
              aria-label="Music volume"
              type="range"
              min={1}
              max={100}
              value={trackVolume}
              onChange={(event) => setTrackVolume(event.currentTarget.valueAsNumber)}
              className="w-full accent-primary"
            />
          </label>
          <label className="block text-sm">
            <span className="flex justify-between">
              Original audio <span>{originalVolume}%</span>
            </span>
            <input
              aria-label="Original audio volume"
              type="range"
              min={1}
              max={100}
              value={originalVolume}
              onChange={(event) => setOriginalVolume(event.currentTarget.valueAsNumber)}
              className="w-full accent-primary"
            />
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            {selected && (
              <button
                type="button"
                className={micro.btnSoft}
                onClick={() => {
                  setChoice(null);
                  onSelect(null);
                }}
              >
                Remove audio
              </button>
            )}
            <button
              type="button"
              className={micro.btnPrimary}
              onClick={() => {
                if (!active && !selected) return;
                onSelect({
                  sourceKey: video.key,
                  connectionId,
                  audioId: selectedId,
                  title: active?.title || selected!.title,
                  creator: active?.creator ?? selected?.creator ?? null,
                  originalVolume,
                  trackVolume,
                });
              }}
            >
              Use audio
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
