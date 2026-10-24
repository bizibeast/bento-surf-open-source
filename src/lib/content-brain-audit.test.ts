import { describe, expect, it } from "vitest";
import { indexBrainAuditSources, type BrainAuditSource } from "./content-brain-audit";

const social: BrainAuditSource = {
  kind: "social",
  recordId: "source-row",
  sourceRef: "threads:shared",
  snapshot: { text: "I raised money from a post.", publishedAt: "2026-01-12T12:29:07Z" },
  asOf: "2026-10-16T02:02:08Z",
};
const creator: BrainAuditSource = {
  kind: "creator",
  recordId: "voice-row",
  sourceRef: "threads:shared",
  snapshot: { title: "Writing voice", text: "Use short sentences." },
  asOf: "2026-10-19T00:00:00Z",
};

describe("Brain audit evidence identity", () => {
  it("keeps a locked instruction and the original caption distinct despite identical citation refs", () => {
    const index = indexBrainAuditSources([social, creator]);
    expect(index.sources).toHaveLength(2);
    expect(index.resolve("social", social.sourceRef)).toMatchObject({
      id: "social:source-row",
      snapshot: { text: social.snapshot.text, publishedAt: "2026-01-12T12:29:07Z" },
    });
    expect(index.resolve("creator", creator.sourceRef)).toMatchObject({
      id: "creator:voice-row",
      snapshot: creator.snapshot,
    });
    expect(index.resolve("social", social.sourceRef).sha256).not.toBe(
      index.resolve("creator", creator.sourceRef).sha256,
    );
  });
  it("rejects conflicting record snapshots and ambiguous same-kind refs instead of overwriting", () => {
    expect(() =>
      indexBrainAuditSources([social, { ...social, snapshot: { text: "Different" } }]),
    ).toThrow("Conflicting");
    const index = indexBrainAuditSources([social, { ...social, recordId: "another-row" }]);
    expect(() => index.resolve("social", social.sourceRef)).toThrow("found 2");
  });
});
