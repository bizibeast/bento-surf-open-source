/** Request a cached WebP preview only for images served by Bento's media CDN. */
export function mediaPreviewUrl(value: string, width: 320 | 640 | 1280): string {
  try {
    const url = new URL(value, "http://localhost:8080");
    if (
      !url.pathname.startsWith("/cdn/users/") ||
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
