import { newsletterPublicSlug } from "./newsletter";

export type NewsletterPublicationSummary = {
  id: string;
  title: string;
  slug: string;
  logoUrl: string | null;
  status: string;
  isDefault: boolean;
  subscriberCount: number;
};

export function resolveSelectedPublicationId(
  publications: Array<{ id: string; isDefault: boolean }>,
  requested?: string,
) {
  return (
    publications.find((item) => item.id === requested)?.id ??
    publications.find((item) => item.isDefault)?.id ??
    publications[0]?.id ??
    null
  );
}

export function uniquePublicationSlug(title: string, existingSlugs: string[]) {
  const base = newsletterPublicSlug(title).slice(0, 96).replace(/-+$/g, "");
  const existing = new Set(existingSlugs);
  if (!existing.has(base)) return base;

  let suffix = 2;
  let candidate = "";
  do {
    const suffixText = `-${suffix}`;
    candidate = `${base.slice(0, 96 - suffixText.length).replace(/-+$/g, "")}${suffixText}`;
    suffix += 1;
  } while (existing.has(candidate));
  return candidate;
}
