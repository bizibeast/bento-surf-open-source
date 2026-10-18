const PREVIEW_WIDTHS = [320, 512, 640, 1280] as const;
export type MediaPreviewWidth = (typeof PREVIEW_WIDTHS)[number];

/** Request a cached WebP preview only for images served by Bento's media CDN. */
export function mediaPreviewUrl(value: string, width: MediaPreviewWidth): string {
  try {
    const url = new URL(value, "http://localhost:8080");
    const hosted =
      url.pathname.startsWith("/cdn/users/") || url.pathname.startsWith("/cdn/avatars/");
    if (
      !hosted ||
      !(
        url.origin === new URL(import.meta.env.VITE_PUBLIC_URL || "http://localhost:8080").origin ||
        url.origin === new URL(import.meta.env.VITE_APP_URL || "http://localhost:8080").origin ||
        url.hostname === "localhost"
      )
    ) {
      return value;
    }
    url.searchParams.set("w", String(width));
    return value.startsWith("/") ? `${url.pathname}${url.search}` : url.toString();
  } catch {
    return value;
  }
}

const SUPABASE_PUBLIC_OBJECT = /^\/storage\/v1\/object\/public\/[a-z0-9][a-z0-9._/-]*$/i;

/** Point avatars at a resized same-origin URL. Leaves unrelated URLs unchanged. */
export function avatarDeliveryUrl(value: string | null | undefined) {
  const raw = value?.trim();
  if (!raw) return null;
  const preview = mediaPreviewUrl(raw, 512);
  if (preview !== raw) return preview;
  try {
    const url = new URL(raw);
    if (
      url.protocol === "https:" &&
      url.hostname.endsWith(".supabase.co") &&
      SUPABASE_PUBLIC_OBJECT.test(url.pathname) &&
      !url.pathname.includes("..") &&
      !url.search &&
      !url.hash
    ) {
      return `/api/image?w=512&src=${encodeURIComponent(url.toString())}`;
    }
    if (url.protocol === "https:" || url.protocol === "http:") return raw;
  } catch {
    return null;
  }
  return null;
}
