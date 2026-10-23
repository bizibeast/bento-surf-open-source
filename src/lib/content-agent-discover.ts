import { discoverPostKey } from "./content-discover-identity";

type Recommendation = Record<string, unknown>;

/** Share current research without turning every chat into another paid search. */
export function mergeAgentDiscoverSources(saved: Recommendation[], fresh: Recommendation[]) {
  const key = (item: Recommendation) =>
    typeof item.sourceUrl === "string" && item.sourceUrl
      ? discoverPostKey({ sourceUrl: item.sourceUrl })
      : String(item.id || "");
  const excluded = new Set(saved.filter((item) => item.feedback === "not_relevant").map(key));
  const savedByKey = new Map(saved.map((item) => [key(item), item]));
  const current = fresh.map((row) => {
    const sourceUrl = row.source_url;
    const previous = savedByKey.get(key({ sourceUrl }));
    return {
      ...previous,
      id: previous?.id || `brief:${key({ sourceUrl })}`,
      title: row.title,
      summary: row.summary,
      sourceUrl,
      sourceName: row.source_name,
      sourcePublishedAt: row.source_published_at,
      reason: row.reason,
      feedback: previous?.feedback || "pending",
    };
  });
  const seen = new Set<string>();
  return [...current, ...saved]
    .filter((item) => {
      const identity = key(item);
      if (!identity || excluded.has(identity) || seen.has(identity)) return false;
      seen.add(identity);
      return true;
    })
    .slice(0, 50);
}
