import type { BrainItem, BrainItemInput } from "./content-brain";

export type MemoryDocumentKind = "profile" | "instruction";
const reference = (kind: MemoryDocumentKind) => `benny:memory-document:${kind}:v1`;
export function isGeneralInstruction(item: { kind: string; tags?: string[] }) {
  return (
    item.kind === "instruction" &&
    !item.tags?.some((tag) => ["skill", "creative-preference", "topic-preferences"].includes(tag))
  );
}

/** A creator-edited document supersedes imported fragments without deleting source history. */
export function activeBrainItems<
  T extends {
    kind: string;
    provenance?: string;
    status?: string;
    tags?: string[];
    sourceRef?: string | null;
    source_ref?: string | null;
    createdAt?: string;
    created_at?: string;
    updatedAt?: string;
    updated_at?: string;
  },
>(items: T[]): T[] {
  const canonical = new Map<MemoryDocumentKind, T>();
  for (const item of items) {
    const kind = item.kind as MemoryDocumentKind;
    if (
      ["profile", "instruction"].includes(kind) &&
      item.provenance === "creator" &&
      item.status === "confirmed" &&
      (item.sourceRef ?? item.source_ref) === reference(kind) &&
      !canonical.has(kind)
    )
      canonical.set(kind, item);
  }
  return items.filter((item) => {
    const kind = item.kind as MemoryDocumentKind;
    const document = canonical.get(kind);
    return (
      !document ||
      item === document ||
      (kind === "instruction" && !isGeneralInstruction(item)) ||
      (["creator", "agent_chat"].includes(item.provenance ?? "") &&
        (item.createdAt ?? item.created_at ?? "") >
          (document.updatedAt ?? document.updated_at ?? ""))
    );
  });
}

export function memoryDocument(items: BrainItem[], kind: MemoryDocumentKind, fallback = "") {
  const canonical = items.find(
    (item) =>
      item.sourceRef === reference(kind) &&
      item.provenance === "creator" &&
      item.status === "confirmed",
  );
  if (canonical) {
    const additions = activeBrainItems(items).filter(
      (item) =>
        item !== canonical &&
        (kind === "profile" ? item.kind === "profile" : isGeneralInstruction(item)),
    );
    return [
      canonical.content,
      ...additions.map((item) => `## ${item.title}\n\n${item.content}`),
    ].join("\n\n");
  }
  const fragments = items.filter((item) =>
    kind === "profile" ? item.kind === "profile" : isGeneralInstruction(item),
  );
  return fragments.length
    ? fragments
        .map((item) => {
          const body = item.content.trim();
          return /^#{1,6}\s/.test(body) ? body : `## ${item.title}\n\n${body}`;
        })
        .join("\n\n")
    : fallback;
}

export function memoryDocumentInput(
  items: BrainItem[],
  kind: MemoryDocumentKind,
  content: string,
): BrainItemInput {
  const prior = items.find((item) => item.sourceRef === reference(kind));
  const title = kind === "profile" ? "About You" : "Instructions";
  return {
    ...(prior ? { id: prior.id } : {}),
    kind,
    title,
    content: content.trim() || `# ${title}`,
    sourceRef: reference(kind),
    provenance: "creator",
    status: "confirmed",
    locked: true,
    tags: ["memory-document"],
  };
}

export const topicReference = (section: "pillars" | "other") => `benny:topics:${section}:v1`;
