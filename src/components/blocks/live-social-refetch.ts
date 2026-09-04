import type { SocialPreview } from "@/lib/social-preview.functions";

export function liveSocialRefetchInterval(
  _platform: string,
  preview: SocialPreview | undefined,
  _dataUpdateCount: number,
) {
  if (!preview || (preview.refreshing && !preview.available)) return 8_000;
  return preview.refreshing ? 30_000 : false;
}
