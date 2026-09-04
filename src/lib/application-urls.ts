export const DEFAULT_APP_ORIGIN = "http://localhost:8080";
export const DEFAULT_PUBLIC_ORIGIN = "http://localhost:8080";

export function normalizeOrigin(value: string | null | undefined, fallback: string) {
  const candidate = value?.trim() || fallback;
  try {
    const url = new URL(candidate);
    return url.origin;
  } catch {
    return fallback;
  }
}

export function configuredAppOrigin(value?: string | null) {
  return normalizeOrigin(value, DEFAULT_APP_ORIGIN);
}

export function configuredPublicOrigin(value?: string | null) {
  return normalizeOrigin(value, DEFAULT_PUBLIC_ORIGIN);
}

export function configuredMcpEndpoint(appOrigin?: string | null) {
  return `${configuredAppOrigin(appOrigin)}/mcp`;
}

export function normalizePublicUsername(value: string) {
  const decoded = value.startsWith("@") ? value.slice(1) : value;
  return decoded.trim().toLowerCase();
}

export function publicCreatorPath(username: string, ...segments: Array<string | null | undefined>) {
  const base = `/@${encodeURIComponent(normalizePublicUsername(username))}`;
  const suffix = segments
    .filter((segment): segment is string => Boolean(segment))
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return suffix ? `${base}/${suffix}` : base;
}

export function publicProfilePath(username: string, pageSlug?: string | null) {
  return publicCreatorPath(username, pageSlug);
}

export function publicProductPath(username: string, productSlug: string) {
  return publicCreatorPath(username, "products", productSlug);
}

export function publicStorePath(username: string) {
  return publicCreatorPath(username, "store");
}

export function publicNewsletterPath(username: string) {
  return publicCreatorPath(username, "newsletter");
}

export function publicNewslettersPath(username: string) {
  return publicCreatorPath(username, "newsletters");
}

export function publicNewsletterIssuePath(username: string, issueSlug: string) {
  return publicCreatorPath(username, "newsletter", issueSlug);
}

export function publicNewsletterPublicationPath(username: string, publicationSlug: string) {
  return publicCreatorPath(username, "newsletters", publicationSlug);
}

export function publicNewsletterPostPath(
  username: string,
  publicationSlug: string,
  postSlug: string,
) {
  return publicCreatorPath(username, "newsletters", publicationSlug, postSlug);
}

export function publicProductSuccessPath(username: string, productSlug: string) {
  return publicCreatorPath(username, "products", productSlug, "success");
}

export function publicProfileUrl(
  username: string,
  pageSlug?: string | null,
  publicOrigin?: string | null,
) {
  return `${configuredPublicOrigin(publicOrigin)}${publicProfilePath(username, pageSlug)}`;
}

export function publicProductUrl(
  username: string,
  productSlug: string,
  publicOrigin?: string | null,
) {
  return `${configuredPublicOrigin(publicOrigin)}${publicProductPath(username, productSlug)}`;
}
