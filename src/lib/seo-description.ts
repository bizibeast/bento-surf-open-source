export const SEO_DESCRIPTION_MIN = 70;
export const SEO_DESCRIPTION_MAX = 160;

/** Clamp public meta descriptions into the range Ahrefs accepts. */
export function seoMetaDescription(value: string | null | undefined, fallback: string) {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  const spare = fallback.replace(/\s+/g, " ").trim();
  const chosen = text.length >= SEO_DESCRIPTION_MIN ? text : spare;
  if (chosen.length <= SEO_DESCRIPTION_MAX) return chosen;
  const slice = chosen.slice(0, SEO_DESCRIPTION_MAX - 1);
  const word = slice.lastIndexOf(" ");
  const cut = (word >= SEO_DESCRIPTION_MIN ? slice.slice(0, word) : slice).replace(
    /[\s,;:.!-]+$/u,
    "",
  );
  return `${cut}.`;
}

export function seoDocumentTitle(title: string, suffix = " | bento.surf", max = 65) {
  const full = `${title}${suffix}`;
  if (full.length <= max) return full;
  if (title.length <= max) return title;
  return `${title.slice(0, max - 1).trimEnd()}…`;
}
