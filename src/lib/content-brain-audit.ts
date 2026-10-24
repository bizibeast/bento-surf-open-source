import { brainEvidenceSha256 } from "./content-brain-evidence";

export type BrainAuditSource = {
  kind: "social" | "creator" | "settings";
  recordId: string;
  sourceRef: string;
  snapshot: Record<string, unknown>;
  asOf: string | null;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Audit evidence must contain JSON values only.");
  return encoded;
}

/** A citation reference is provenance, never a globally unique evidence-record ID. */
export function indexBrainAuditSources(inputs: BrainAuditSource[]) {
  const byId = new Map<string, BrainAuditSource & { id: string; sha256: string }>();
  for (const input of inputs) {
    const id = `${input.kind}:${input.recordId}`;
    const source = { ...input, id, sha256: brainEvidenceSha256(canonical(input.snapshot)) };
    const previous = byId.get(id);
    if (previous && (previous.sha256 !== source.sha256 || previous.sourceRef !== source.sourceRef))
      throw new Error(`Conflicting evidence snapshots for ${id}; resolve them before auditing.`);
    byId.set(id, source);
  }
  return {
    sources: [...byId.values()],
    byId,
    resolve(kind: BrainAuditSource["kind"], sourceRef: string) {
      const matches = [...byId.values()].filter(
        (source) => source.kind === kind && source.sourceRef === sourceRef,
      );
      if (matches.length !== 1)
        throw new Error(
          `Expected one ${kind} evidence record for ${sourceRef}; found ${matches.length}.`,
        );
      return matches[0];
    },
  };
}
