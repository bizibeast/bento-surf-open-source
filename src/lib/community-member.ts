export type CommunityResource = {
  label: string;
  url: string;
};

export function communityMemberName(grant: { member_name?: string | null; buyer_email: string }) {
  const explicit = grant.member_name?.trim();
  if (explicit) return explicit.slice(0, 120);
  const localPart = grant.buyer_email.split("@")[0]?.trim();
  return (localPart || "Member").slice(0, 120);
}

export function normalizeCommunityResources(
  resources: Array<{ label?: string | null; url?: string | null }>,
) {
  const normalized: CommunityResource[] = [];
  for (const resource of resources.slice(0, 5)) {
    const label = resource.label?.trim().slice(0, 80);
    const value = resource.url?.trim();
    if (!label || !value) continue;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) continue;
      normalized.push({ label, url: url.toString() });
    } catch {
      // Ignore malformed resources instead of persisting unsafe links.
    }
  }
  return normalized;
}
