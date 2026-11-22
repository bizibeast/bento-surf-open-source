import { BRAIN_ITEM_COLUMNS } from "./large-table-columns";

/** Always load creator overrides, even when newer imports fill the context's recent-item page. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Brain tables predate generated types.
export async function loadBrainMemoryDocuments(db: any, userId: string) {
  const results = await Promise.all(
    ["profile", "instruction"].map((kind) =>
      db
        .from("creator_brain_items")
        .select(BRAIN_ITEM_COLUMNS)
        .eq("user_id", userId)
        .eq("kind", kind)
        .eq("source_ref", `benny:memory-document:${kind}:v1`)
        .eq("provenance", "creator")
        .eq("status", "confirmed")
        .order("updated_at", { ascending: false })
        .limit(1),
    ),
  );
  if (results.some((result) => result.error))
    throw new Error("Creator memory could not be loaded.");
  return results.flatMap((result) => result.data || []);
}
