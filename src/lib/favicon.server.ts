import { readResponseBytes } from "./request-security.server";
export async function handleFaviconRequest(request: Request) {
  if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405 });
  const domain = new URL(request.url).searchParams.get("domain") || "";
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(domain))
    return new Response(null, { status: 400 });
  const google = new URL("https://t0.gstatic.com/faviconV2");
  google.search = new URLSearchParams({
    client: "SOCIAL",
    type: "FAVICON",
    fallback_opts: "TYPE,SIZE,URL",
    url: "https://" + domain,
    size: "128",
  }).toString();
  for (const url of [
    google.toString(),
    "https://icons.duckduckgo.com/ip3/" + encodeURIComponent(domain) + ".ico",
  ]) {
    try {
      const upstream = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "manual" });
      const type = upstream.headers.get("content-type")?.split(";")[0] || "";
      if (
        !upstream.ok ||
        ![
          "image/png",
          "image/jpeg",
          "image/webp",
          "image/gif",
          "image/x-icon",
          "image/vnd.microsoft.icon",
        ].includes(type)
      ) {
        await upstream.body?.cancel();
        continue;
      }
      const bytes = await readResponseBytes(upstream, 256 * 1024);
      return new Response(request.method === "HEAD" ? null : bytes, {
        headers: {
          "content-type": type,
          "cache-control": "public, max-age=86400",
          "x-content-type-options": "nosniff",
          "access-control-allow-origin": "*",
        },
      });
    } catch {
      /* Try the independent icon CDN if the first one is unavailable. */
    }
  }
  return new Response(null, { status: 404 });
}
