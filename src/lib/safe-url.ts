import { configuredAppOrigin, DEFAULT_APP_ORIGIN, DEFAULT_PUBLIC_ORIGIN } from "./application-urls";

const PRIVATE_DOMAIN_SUFFIXES = [
  ".internal",
  ".intranet",
  ".lan",
  ".local",
  ".localhost",
  ".home",
  ".test",
  ".invalid",
] as const;

function ipv4Number(hostname: string) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return null;
  const octets = hostname.split(".").map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return null;
  return (((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3]) >>> 0;
}

function inIpv4Range(address: number, base: number, prefix: number) {
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (base & mask);
}

/**
 * Rejects literal and named hosts that browsers or a server-side fetch must not
 * treat as public Internet destinations. URL parsing normalizes octal, hex, and
 * integer IPv4 forms before this function is called.
 */
export function isPrivateOrReservedHostname(input: string) {
  const hostname = input
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (!hostname) return true;
  if (
    hostname === "localhost" ||
    hostname === "localhost.localdomain" ||
    hostname.endsWith(".localhost") ||
    PRIVATE_DOMAIN_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    return true;
  }

  // Literal IPv6 destinations are deliberately rejected. This avoids the many
  // private, link-local, mapped-IPv4, and zone-id representations while still
  // allowing normal public hostnames with AAAA records.
  if (hostname.includes(":")) return true;

  const address = ipv4Number(hostname);
  if (address !== null) {
    return [
      [0x00000000, 8],
      [0x0a000000, 8],
      [0x64400000, 10],
      [0x7f000000, 8],
      [0xa9fe0000, 16],
      [0xac100000, 12],
      [0xc0000000, 24],
      [0xc0000200, 24],
      [0xc0586300, 24],
      [0xc0a80000, 16],
      [0xc6120000, 15],
      [0xc6336400, 24],
      [0xcb007100, 24],
      [0xe0000000, 4],
      [0xf0000000, 4],
    ].some(([base, prefix]) => inIpv4Range(address, base, prefix));
  }

  // Single-label names resolve through local search domains on many systems.
  return !hostname.includes(".");
}

export function parsePublicHttpUrl(
  value: unknown,
  options: { requireHttps?: boolean; allowNonStandardPort?: boolean } = {},
) {
  if (typeof value !== "string" || value.length > 2_048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const allowedProtocol =
    url.protocol === "https:" || (!options.requireHttps && url.protocol === "http:");
  if (!allowedProtocol) return null;
  if (url.username || url.password || isPrivateOrReservedHostname(url.hostname)) return null;
  if (
    options.allowNonStandardPort === false &&
    url.port &&
    !(
      (url.protocol === "https:" && url.port === "443") ||
      (url.protocol === "http:" && url.port === "80")
    )
  ) {
    return null;
  }
  return url;
}

/** Safe value for an anchor or top-level navigation. */
export function safeNavigationHref(value: unknown, options: { allowRelative?: boolean } = {}) {
  if (typeof value !== "string" || !value || value.length > 2_048) return null;
  if (options.allowRelative && value.startsWith("/") && !value.startsWith("//")) return value;
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(value)) return value;
  if (/^tel:\+?[0-9().\-\s]{3,40}$/i.test(value)) return value;
  return parsePublicHttpUrl(value)?.toString() ?? null;
}

/** Safe value for image, audio, or video resource attributes. */
export function safeMediaUrl(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 2_048) return null;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  return parsePublicHttpUrl(value)?.toString() ?? null;
}

/** Safe public media value that can be emitted into server-rendered pages. */
export function safePublicMediaUrl(value: unknown) {
  return safeMediaUrl(value);
}

export function safeSpotifyEmbedUrl(value: unknown) {
  const url = parsePublicHttpUrl(value, { requireHttps: true });
  if (!url || url.hostname.toLowerCase() !== "open.spotify.com") return null;
  return url.pathname.startsWith("/embed/") ? url.toString() : null;
}

/** A deliberately small color grammar for user-configurable inline styles. */
export function safeCssColor(value: unknown) {
  if (typeof value !== "string" || value.length > 96) return null;
  const color = value.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(color)) return color;
  if (/^(?:rgb|rgba|hsl|hsla|oklch)\([0-9.%+,/\-\s]+\)$/i.test(color)) return color;
  return null;
}

export function sanitizeLocalRedirect(value: unknown, fallback = "/link") {
  if (typeof value !== "string" || value.length > 1_024) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  try {
    const url = new URL(value, DEFAULT_PUBLIC_ORIGIN);
    if (url.origin !== DEFAULT_PUBLIC_ORIGIN) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

const CUSTOMER_LIBRARY_PRIORITY_DM_PATH =
  /^\/library\/priority-dm\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function sanitizeCustomerLibraryReturnTo(value: unknown) {
  const safe = sanitizeLocalRedirect(value, "/library");
  return safe === "/library" || CUSTOMER_LIBRARY_PRIORITY_DM_PATH.test(safe) ? safe : "/library";
}

export function stripUrlSearchParameters(value: string, names: readonly string[]) {
  const url = new URL(value);
  for (const name of names) url.searchParams.delete(name);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function redactSensitivePathname(pathname: string) {
  const segments = pathname.split("/");
  const sensitiveIndex =
    segments[1] === "access" || segments[1] === "review"
      ? 2
      : segments[1] === "payments" && segments[2] === "razorpay"
        ? 3
        : segments[1] === "library" && segments[2] === "receipts"
          ? 3
          : segments[1] === "api" && segments[2] === "commerce" && segments[3] === "download"
            ? 4
            : -1;
  if (sensitiveIndex > 0 && segments[sensitiveIndex]) segments[sensitiveIndex] = "[redacted]";
  return segments.join("/");
}

function isTrustedApplicationOrigin(url: URL) {
  const hostname = url.hostname.toLowerCase();
  return (
    ["localhost", "127.0.0.1"].includes(hostname) &&
    (url.protocol === "http:" || url.protocol === "https:")
  );
}

export function trustedApplicationOrigin(current: unknown, configured?: unknown) {
  const configuredOrigin = configuredAppOrigin(
    typeof configured === "string" ? configured : undefined,
  );
  if (typeof configured === "string" && configured.trim()) return configuredOrigin;
  if (typeof current === "string") {
    try {
      const url = new URL(current);
      if (isTrustedApplicationOrigin(url)) return url.origin;
    } catch {
      // Fall back to the local-safe application origin.
    }
  }
  return DEFAULT_APP_ORIGIN;
}
