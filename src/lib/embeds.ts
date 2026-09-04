import { parsePublicHttpUrl } from "@/lib/safe-url";

export function googleMapsEmbedUrl(location: string) {
  const query = location.trim();
  if (!query) return "";
  const url = new URL("https://www.google.com/maps");
  url.searchParams.set("q", query);
  url.searchParams.set("z", "14");
  url.searchParams.set("output", "embed");
  return url.toString();
}

export function extractWidgetUrl(input: string) {
  const trimmed = input.trim().slice(0, 20_000);
  const iframeSrc = trimmed.match(/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/i)?.[1];
  const candidate = iframeSrc ?? trimmed;
  return (
    parsePublicHttpUrl(candidate, {
      requireHttps: true,
      allowNonStandardPort: false,
    })?.toString() ?? null
  );
}
