import { ProviderPostPreview } from "@/components/scheduler/ProviderPostPreview";
import {
  isPublicSocialProvider,
  SOCIAL_PROVIDER_DEFINITIONS,
  type SchedulerConnection,
  type SchedulerMedia,
} from "@/lib/social-scheduler";

export function ContentDraftPreview({
  platform,
  body,
  title,
  assets,
  connection,
}: {
  platform: string;
  body: string;
  title?: string;
  assets: Record<string, string>;
  connection?: SchedulerConnection;
}) {
  if (!isPublicSocialProvider(platform))
    return <p className="whitespace-pre-wrap break-words text-sm leading-7">{body}</p>;
  const provider = platform as SchedulerConnection["provider"];
  const account: SchedulerConnection = connection || {
    id: "preview",
    provider,
    handle: "your-account",
    displayName: "Your account",
    avatarUrl: null,
    status: "active",
    connectedAt: "",
    canPublish: false,
    publishBlockReason: null,
  };
  const media: SchedulerMedia[] = Object.entries(assets).map(([id, url]) => ({
    key: id,
    url,
    name: "Currently attached draft image",
    mimeType: "image/jpeg",
    size: 1,
  }));
  return (
    <div
      className="mt-3 min-w-0 rounded-2xl border border-border bg-muted/30 p-3 sm:p-4"
      aria-label={`${SOCIAL_PROVIDER_DEFINITIONS[provider].name} draft preview`}
    >
      <p className="mb-3 text-xs font-medium text-muted-foreground">
        {SOCIAL_PROVIDER_DEFINITIONS[provider].name} preview · review before posting
      </p>
      <ProviderPostPreview
        connection={account}
        body={body}
        title={title || ""}
        media={media}
        youtubeThumbnail={null}
        youtubeFormat={null}
        instagramCover={null}
        tiktokPrivacy="SELF_ONLY"
        youtubePrivacy="private"
        redditCommunity=""
        redditKind="self"
        redditUrl=""
      />
    </div>
  );
}
