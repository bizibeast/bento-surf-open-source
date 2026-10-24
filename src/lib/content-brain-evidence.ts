import { hash } from "fast-sha256";
import { z } from "zod";

export const BRAIN_EVIDENCE_VERSION = 3;

export const brainEvidenceReceiptSchema = z.object({
  version: z.literal(BRAIN_EVIDENCE_VERSION),
  state: z.literal("verified"),
  documentHash: z.string().regex(/^[a-f0-9]{64}$/),
  reviewedAt: z.string().datetime({ offset: true }),
  method: z.enum(["independent_source_review", "operator_source_audit"]),
  auditId: z.string().min(1).max(200).optional(),
  sources: z
    .array(
      z.object({
        id: z.string().min(1).max(500),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        asOf: z.string().datetime({ offset: true }).nullable(),
      }),
    )
    .min(1)
    .max(32),
});
export type BrainEvidenceReceipt = z.infer<typeof brainEvidenceReceiptSchema>;

export type BrainEvidenceDocument = {
  kind?: unknown;
  title?: unknown;
  content?: unknown;
  sourceRef?: unknown;
  source_ref?: unknown;
  sourceUrl?: unknown;
  source_url?: unknown;
};

export function brainEvidenceSha256(value: string) {
  return Array.from(hash(new TextEncoder().encode(value)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** UTF-8 byte lengths make field boundaries unambiguous, including Unicode/newlines. */
export function brainDocumentEvidenceHash(item: BrainEvidenceDocument) {
  const fields = [
    String(BRAIN_EVIDENCE_VERSION),
    String(item.kind || ""),
    String(item.title || ""),
    String(item.content || ""),
    String(item.sourceRef ?? item.source_ref ?? ""),
    String(item.sourceUrl ?? item.source_url ?? ""),
  ];
  return brainEvidenceSha256(
    fields.map((value) => `${new TextEncoder().encode(value).byteLength}:${value}`).join("|"),
  );
}

export function hasCurrentBrainEvidence(
  item: BrainEvidenceDocument & {
    evidenceVerification?: unknown;
    evidence_verification?: unknown;
  },
) {
  const receipt = brainEvidenceReceiptSchema.safeParse(
    item.evidenceVerification ?? item.evidence_verification,
  );
  return receipt.success && receipt.data.documentHash === brainDocumentEvidenceHash(item);
}

/** Confirmation is creator authority or an exact, current source review, never a legacy label alone. */
export function isTrustedBrainItem(
  item: BrainEvidenceDocument & {
    status?: unknown;
    locked?: unknown;
    provenance?: unknown;
    evidenceVerification?: unknown;
    evidence_verification?: unknown;
  },
) {
  return (
    item.status === "confirmed" &&
    (item.locked === true || item.provenance === "creator" || hasCurrentBrainEvidence(item))
  );
}

/** Called only after a successful independent verifier or reviewed operator audit. */
export function createBrainEvidenceReceipt(
  item: BrainEvidenceDocument,
  sources: BrainEvidenceReceipt["sources"],
  options: Pick<BrainEvidenceReceipt, "method" | "auditId"> & { reviewedAt?: string },
): BrainEvidenceReceipt {
  return brainEvidenceReceiptSchema.parse({
    version: BRAIN_EVIDENCE_VERSION,
    state: "verified",
    documentHash: brainDocumentEvidenceHash(item),
    reviewedAt: options.reviewedAt || new Date().toISOString(),
    method: options.method,
    ...(options.auditId ? { auditId: options.auditId } : {}),
    sources,
  });
}
