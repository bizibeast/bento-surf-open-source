import { describe, expect, it } from "vitest";
import { brainItemFromRow, brainItemInputSchema } from "./content-brain";
import {
  brainDocumentEvidenceHash,
  brainEvidenceSha256,
  createBrainEvidenceReceipt,
  isTrustedBrainItem,
} from "./content-brain-evidence";

const row = {
  id: "00000000-0000-4000-8000-000000000001",
  kind: "story",
  title: "What I posted 🤖",
  content: "I discussed another person's app.\nI did not build it.",
  source_ref: "instagram:123",
  source_url: "https://example.com/post",
  status: "confirmed",
  provenance: "social_post",
  locked: false,
  tags: [],
  created_at: "2026-10-23T00:00:00Z",
  updated_at: "2026-10-23T00:00:00Z",
};
const receipt = () =>
  createBrainEvidenceReceipt(
    row,
    [
      {
        id: row.source_ref,
        sha256: brainEvidenceSha256("I discussed another person's app."),
        asOf: "2026-10-22T00:00:00Z",
      },
    ],
    { method: "operator_source_audit", auditId: "fixture", reviewedAt: "2026-10-23T00:00:00Z" },
  );

describe("Brain source trust", () => {
  it("does not elevate legacy confirmed/source-linked prose, but preserves creator authority", () => {
    expect(isTrustedBrainItem(row)).toBe(false);
    expect(brainItemFromRow(row).status).toBe("suggested");
    expect(isTrustedBrainItem({ ...row, locked: true })).toBe(true);
    expect(isTrustedBrainItem({ ...row, provenance: "creator" })).toBe(true);
    expect(isTrustedBrainItem({ ...row, status: "suggested", locked: true })).toBe(false);
  });

  it("accepts exact reviewed content in raw and mapped form and rejects stale/forged receipts", () => {
    const verified = { ...row, evidence_verification: receipt() };
    expect(isTrustedBrainItem(verified)).toBe(true);
    expect(isTrustedBrainItem(brainItemFromRow(verified))).toBe(true);
    for (const field of ["content", "title", "kind", "source_ref", "source_url"] as const)
      expect(isTrustedBrainItem({ ...verified, [field]: `${row[field]} changed` }), field).toBe(
        false,
      );
    for (const bad of [
      null,
      {},
      { ...receipt(), version: 2 },
      { ...receipt(), documentHash: "a".repeat(64) },
      { ...receipt(), sources: [] },
    ])
      expect(isTrustedBrainItem({ ...row, evidence_verification: bad })).toBe(false);
  });

  it("uses unambiguous UTF-8 fields and strips receipts from caller-writable schemas", () => {
    expect(brainEvidenceSha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(
      brainDocumentEvidenceHash({
        kind: "story",
        title: "Unicode 👩🏽‍💻|₹",
        content: 'Quoted "text"\nwith|boundaries',
        sourceRef: "instagram:1",
        sourceUrl: null,
      }),
    ).toBe("496ffded7024ba541bdbabe85d73d6139d43c8d0d67612be4fe7e61c2d303bee");
    expect(brainDocumentEvidenceHash({ ...row, title: "a|b", content: "c" })).not.toBe(
      brainDocumentEvidenceHash({ ...row, title: "a", content: "b|c" }),
    );
    const input = brainItemInputSchema.parse({
      ...row,
      sourceRef: row.source_ref,
      evidenceVerification: receipt(),
      evidence_verification: receipt(),
    });
    expect(input).not.toHaveProperty("evidenceVerification");
    expect(input).not.toHaveProperty("evidence_verification");
    expect(isTrustedBrainItem(input)).toBe(false);
  });
});
