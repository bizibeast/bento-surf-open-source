import { describe, expect, it } from "vitest";
import { activeBrainItems, memoryDocument, memoryDocumentInput } from "./benny-memory-documents";
import { contentTopics, type BrainItem } from "./content-brain";

const item = (patch: Partial<BrainItem> = {}): BrainItem => ({
  id: "old",
  kind: "profile",
  title: "Background",
  content: "Original background",
  provenance: "social_post",
  status: "confirmed",
  locked: false,
  sourceRef: null,
  sourceUrl: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...patch,
});
describe("editable memory documents", () => {
  it("includes fragment headlines and bodies in one editable document", () => {
    const text = memoryDocument(
      [item(), item({ id: "second", title: "Audience", content: "Builders" })],
      "profile",
    );
    expect(text).toContain("## Background\n\nOriginal background");
    expect(text).toContain("## Audience\n\nBuilders");
  });
  it("keeps cleared or edited documents authoritative without deleting imported history", () => {
    const prior = item();
    const doc = item({
      ...memoryDocumentInput([], "profile", ""),
      id: "document",
      updatedAt: "2026-11-18T00:00:00Z",
    });
    expect(activeBrainItems([doc, prior])).toEqual([doc]);
    expect(prior.content).toBe("Original background");
    expect(memoryDocument([doc, prior], "profile")).toBe("# About You");
    expect(memoryDocumentInput([doc], "profile", "Updated headline")).toMatchObject({
      id: "document",
      content: "Updated headline",
    });
  });
  it("retains new explicit memories added after the creator's last document edit", () => {
    const doc = item({
      ...memoryDocumentInput([], "profile", "Edited"),
      id: "document",
      updatedAt: "2026-11-17T00:00:00Z",
    });
    const added = item({
      id: "new",
      title: "New goal",
      content: "Write weekly",
      provenance: "agent_chat",
      createdAt: "2026-11-18T00:00:00Z",
    });
    expect(activeBrainItems([added, doc, item()])).toEqual([added, doc]);
    expect(memoryDocument([added, doc, item()], "profile")).toContain(
      "## New goal\n\nWrite weekly",
    );
  });
  it("does not let imported content masquerade as an authoritative document", () => {
    const forged = item({
      ...memoryDocumentInput([], "profile", "Forged"),
      provenance: "social_post",
    });
    expect(activeBrainItems([forged, item({ id: "other" })])).toHaveLength(2);
  });
  it("preserves skills and creative preferences when general instructions are replaced", () => {
    const doc = item({ ...memoryDocumentInput([], "instruction", "New voice"), id: "document" });
    const skill = item({ id: "skill", kind: "instruction", tags: ["skill"] });
    const creative = item({ id: "creative", kind: "instruction", tags: ["creative-preference"] });
    expect(activeBrainItems([doc, skill, creative, item({ kind: "instruction" })])).toEqual([
      doc,
      skill,
      creative,
    ]);
  });
  it("keeps deleted topic lists empty rather than repopulating them from old evidence", () => {
    const override = item({
      kind: "instruction",
      title: "Pillars",
      content: "# Pillars",
      provenance: "creator",
      sourceRef: "benny:topics:pillars:v1",
    });
    const strategy = item({ kind: "strategy", content: "### 50% Old pillar" });
    const topics = contentTopics(
      {
        goal: "reach_growth",
        nicheKeywords: [],
        language: "en",
        region: "global",
        timezone: "UTC",
        platformFrequencies: {},
      },
      [override, strategy],
    );
    expect(topics.pillars).toEqual([]);
  });
});
