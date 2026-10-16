/** Stable post identity shared by feed, saved items and related recommendations. */
export function discoverPostKey(item: {
  id?: string;
  fingerprint?: string;
  sourceUrl?: string | null;
  canonicalUrl?: string;
}) {
  const source = item.sourceUrl || item.canonicalUrl;
  if (!source) return item.fingerprint?.replace(/^(trend|idea):/, "source:") || item.id || "";
  try {
    const url = new URL(source);
    let host = url.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");
    if (host === "twitter.com") host = "x.com";
    if (host === "threads.net") host = "threads.com";
    const path = url.pathname.replace(/\/+$/, "");
    if (host === "x.com") {
      const id = path.match(/\/status\/(\d+)/)?.[1];
      if (id) return `x:${id}`;
    }
    if (host === "youtube.com" || host === "youtu.be") {
      const id =
        host === "youtu.be"
          ? path.slice(1)
          : url.searchParams.get("v") || path.match(/^\/(?:shorts|embed)\/([^/]+)/)?.[1];
      if (id) return `youtube:${id}`;
    }
    if (host === "instagram.com") {
      const id = path.match(/^\/(?:p|reel|reels)\/([^/]+)/)?.[1];
      if (id) return `instagram:${id}`;
    }
    if (host === "reddit.com") {
      const id = path.match(/\/comments\/([^/]+)/)?.[1];
      if (id) return `reddit:${id}`;
    }
    if (host === "linkedin.com") {
      const id = path.match(/(?:-activity-|urn:li:activity:)(\d+)/)?.[1];
      if (id) return `linkedin:activity:${id}`;
    }
    if (host === "facebook.com") {
      const id =
        path.match(/\/(?:posts|videos|reel)\/([^/]+)/)?.[1] || url.searchParams.get("story_fbid");
      if (id) return `facebook:${id}`;
    }
    if (host === "tiktok.com") {
      const id = path.match(/\/video\/(\d+)/)?.[1];
      if (id) return `tiktok:${id}`;
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|source$|si$|igsh$)/i.test(key))
        url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return `${host}${path}${url.searchParams.size ? `?${url.searchParams}` : ""}`;
  } catch {
    return source;
  }
}

export function uniqueDiscoverPosts<
  T extends { id: string; sourceUrl: string | null; fingerprint: string; kind: string },
>(items: T[]) {
  const seen = new Set<string>();
  // The original post represents its generated idea in the combined wall.
  return [...items]
    .sort((a, b) => Number(a.kind === "idea") - Number(b.kind === "idea"))
    .filter((item) => {
      const key = discoverPostKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function visibleDiscoverRecommendations<
  T extends { id: string; sourceUrl: string | null; fingerprint: string; feedback: string },
>(items: T[]) {
  const rejected = new Set(
    items.filter((item) => item.feedback === "not_relevant").map(discoverPostKey),
  );
  return items.filter((item) => !rejected.has(discoverPostKey(item)));
}
