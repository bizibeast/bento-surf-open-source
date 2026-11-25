/** Self-contained: this function is serialized into our anonymous browser. */
export function extractPublicPostPage(target: { platform: string; id: string; wanted?: string[] }) {
  const rows: Record<string, unknown>[] = [];
  const visibleCounts: Record<string, string> = {};
  let visited = 0;
  const primitiveKeys = [
    "code",
    "shortcode",
    "id",
    "pk",
    "post_id",
    "legacy_fbid",
    "like_count",
    "comment_count",
    "view_count",
    "video_view_count",
    "video_play_count",
    "play_count",
    "reshare_count",
    "share_count",
    "media_repost_count",
    "repost_count",
    "quote_count",
    "reply_count",
    "threads_view_count",
    "is_private",
    "like_and_view_counts_disabled",
    "share_count_disabled",
  ];
  function object(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
  function thinFeedback(value: unknown) {
    const input = object(value),
      output: Record<string, unknown> = {};
    for (const key of [
      "reaction_count",
      "unified_reactors",
      "likers",
      "comment_count",
      "share_count",
    ]) {
      const count = object(input[key]).count;
      if (typeof count === "number" || typeof count === "string") output[key] = { count };
    }
    for (const key of [
      "total_comment_count",
      "share_count_reduced",
      "video_view_count",
      "view_count",
    ])
      if (typeof input[key] === "number" || typeof input[key] === "string")
        output[key] = input[key];
    return output;
  }
  function matched(item: Record<string, unknown>) {
    if (
      [item.code, item.shortcode, item.id, item.pk, item.post_id, item.legacy_fbid].some(
        (value) => String(value).replace(/^t3_/, "") === target.id,
      )
    )
      return true;
    return (
      target.platform === "Facebook" &&
      (object(item.video).id === target.id ||
        (Array.isArray(item.attachments) &&
          item.attachments.slice(0, 4).some((a) => object(object(a).media).id === target.id)))
    );
  }
  function walk(value: unknown, depth = 0) {
    if (
      !value ||
      typeof value !== "object" ||
      depth > 24 ||
      ++visited > 30_000 ||
      rows.length >= 12
    )
      return;
    const item = object(value);
    if (matched(item)) {
      const row: Record<string, unknown> = {};
      for (const key of primitiveKeys)
        if (["number", "string", "boolean"].includes(typeof item[key]) || item[key] === null)
          row[key] = item[key];
      for (const key of ["user", "owner"])
        if (object(item[key]).is_private === true) row[key] = { is_private: true };
      for (const key of ["edge_media_preview_like", "edge_liked_by", "edge_media_to_comment"]) {
        const count = object(item[key]).count;
        if (typeof count === "number") row[key] = { count };
      }
      if (item.feedback) row.feedback = thinFeedback(item.feedback);
      if (item.fb_reel_react_button)
        row.fb_reel_react_button = {
          story: {
            feedback: thinFeedback(object(object(item.fb_reel_react_button).story).feedback),
          },
        };
      if (target.platform === "Facebook" && object(item.video).id === target.id)
        row.video = { id: target.id };
      if (target.platform === "Facebook" && Array.isArray(item.attachments))
        row.attachments = item.attachments
          .slice(0, 4)
          .filter((a) => object(object(a).media).id === target.id)
          .map(() => ({ media: { id: target.id } }));
      if (item.text_post_app_info) {
        const info = object(item.text_post_app_info),
          out: Record<string, unknown> = {};
        for (const key of ["direct_reply_count", "repost_count", "quote_count", "share_count"])
          if (typeof info[key] === "number") out[key] = info[key];
        row.text_post_app_info = out;
      }
      const useful =
        Object.entries(row).some(
          ([key, value]) => /count$/.test(key) && ["number", "string"].includes(typeof value),
        ) ||
        [
          "feedback",
          "text_post_app_info",
          "edge_media_preview_like",
          "edge_liked_by",
          "edge_media_to_comment",
        ].some((key) => Object.keys(object(row[key])).length > 0) ||
        Object.keys(thinFeedback(object(object(row.fb_reel_react_button).story).feedback)).length >
          0 ||
        row.is_private === true ||
        object(row.user).is_private === true ||
        object(row.owner).is_private === true;
      if (useful) rows.push(row);
    }
    for (const child of Object.values(value))
      if (child && typeof child === "object") walk(child, depth + 1);
  }
  const scripts = Array.from(
    document.querySelectorAll('script[type="application/json"],script[type="application/ld+json"]'),
  ).slice(0, 160);
  let bytes = 0;
  for (const script of scripts) {
    const text = script.textContent || "";
    if (!text.includes(target.id)) continue;
    if (text.length > 1_500_000 || bytes + text.length > 4_000_000) continue;
    bytes += text.length;
    try {
      walk(JSON.parse(text));
    } catch {
      /* Never execute site-provided code. */
    }
  }
  let extraHtml = "";
  if (target.platform === "Reddit") {
    const post = Array.from(document.querySelectorAll("shreddit-post")).find((e) =>
      [e.getAttribute("id"), e.getAttribute("post-id")].includes("t3_" + target.id),
    );
    if (post) extraHtml = post.outerHTML.match(/^<shreddit-post\b[^>]*>/i)?.[0] || "";
  }
  if (target.platform === "Threads") {
    const links = Array.from(
      document.querySelectorAll<HTMLAnchorElement>('a[href*="/post/"]'),
    ).filter((a) => {
      const u = new URL(a.href, "https://threads.com");
      return (
        ["threads.com", "www.threads.com", "threads.net", "www.threads.net"].includes(u.hostname) &&
        u.pathname.match(/\/post\/([^/]+)/)?.[1] === target.id
      );
    });
    const anchor = links.find((a) => a.querySelector("time"));
    const card = anchor?.closest("[data-pressable-container]");
    if (card)
      for (const svg of Array.from(card.querySelectorAll("svg"))) {
        if (svg.closest("[data-pressable-container]") !== card) continue;
        const label =
          svg.getAttribute("aria-label") ||
          svg.getAttribute("title") ||
          svg.querySelector("title")?.textContent ||
          "";
        const key = (
          {
            Like: "likes",
            Unlike: "likes",
            Comment: "comments",
            Reply: "comments",
            Repost: "reshares",
            Share: "shares",
          } as Record<string, string>
        )[label];
        const button = svg.closest('[role="button"],button');
        const text = (button?.textContent || "").replace(label, "").trim();
        if (key && /^(?:\d+(?:,\d{3})*(?:\.\d+)?\s*[KMB]?)$/i.test(text)) visibleCounts[key] = text;
      }
    const title = links.find((a) => a.querySelector("h1"));
    for (let e = title?.parentElement, n = 0; e && n < 3; e = e.parentElement, n++) {
      if (e.querySelector("[data-pressable-container]")) break;
      const views = e.textContent?.match(/([\d,.]+\s*[KMB]?)\s*views\b/i)?.[1];
      if (views) {
        visibleCounts.views = views.trim();
        break;
      }
    }
  }
  const canonicalUrl =
    document.querySelector('meta[property="og:url"]')?.getAttribute("content") ||
    document.querySelector('link[rel="canonical"]')?.getAttribute("href") ||
    null;
  const html =
    rows
      .map(
        (row) =>
          '<script type="application/json">' +
          JSON.stringify(row).replace(/</g, "\\u003c") +
          "</script>",
      )
      .join("") + extraHtml;
  const signatures: Record<string, string[]> = {
    views: [
      "view_count",
      "video_view_count",
      "video_play_count",
      "play_count",
      "threads_view_count",
    ],
    likes: ["like_count", "unified_reactors", "reaction_count", "likers"],
    comments: ["comment_count", "total_comment_count", "direct_reply_count"],
    shares: ["reshare_count", "share_count", "share_count_reduced"],
    reposts: ["media_repost_count", "repost_count"],
    quotes: ["quote_count"],
  };
  const wanted = target.wanted || Object.keys(signatures);
  const ready =
    !!extraHtml ||
    wanted.some(
      (key) =>
        visibleCounts[key] !== undefined ||
        (signatures[key] || []).some((field) =>
          new RegExp('"' + field + '"\\s*:\\s*(?:[0-9]|"[0-9]|\\{"count"\\s*:\\s*[0-9])').test(
            html,
          ),
        ),
    );
  return {
    value: html,
    visibleCounts,
    canonicalUrl,
    ready,
    jsonBlocks: scripts.length,
    matchedItems: rows.length,
    loginForm: !!document.querySelector('input[type="password"]'),
  };
}
