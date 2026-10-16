// ponytail: 20 characters of bio and meta description, plus a public-content flag,
// root blocks, or products. This ignores rendered block text.
// Upgrade path: score the visible block copy if the sitemap view starts returning it.
export const MIN_PUBLIC_PROFILE_COPY_LENGTH = 20;

type PublicProfileQuality = {
  bio?: string | null;
  meta_description?: string | null;
  has_public_content?: boolean | null;
  blocks?: readonly unknown[] | null;
  products?: readonly unknown[] | null;
};

function copyLength(value: unknown) {
  return typeof value === "string" ? value.trim().length : 0;
}

export function hasSubstantivePublicProfileCopy(profile: PublicProfileQuality) {
  return (
    copyLength(profile.bio) >= MIN_PUBLIC_PROFILE_COPY_LENGTH ||
    copyLength(profile.meta_description) >= MIN_PUBLIC_PROFILE_COPY_LENGTH
  );
}

export function hasPublicProfileContent(profile: PublicProfileQuality) {
  return (
    profile.has_public_content === true ||
    (Array.isArray(profile.blocks) && profile.blocks.length > 0) ||
    (Array.isArray(profile.products) && profile.products.length > 0)
  );
}

// Thin only when both copy fields are short and nothing public is attached.
// A caller that did not send copy or content (a calendar head, for example) is not thin.
export function isThinPublicProfile(profile: PublicProfileQuality) {
  const sawSignal =
    profile.bio !== undefined ||
    profile.meta_description !== undefined ||
    profile.has_public_content !== undefined ||
    profile.blocks !== undefined ||
    profile.products !== undefined;
  if (!sawSignal) return false;
  return !hasSubstantivePublicProfileCopy(profile) && !hasPublicProfileContent(profile);
}
