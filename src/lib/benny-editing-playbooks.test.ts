import { describe, expect, it } from "vitest";
import { brainItemInputSchema, type BrainItem } from "./content-brain";
import {
  BENNY_EDITING_PLAYBOOKS,
  creativePreferenceContext,
  editingPlaybookMemory,
  savedEditingPlaybook,
} from "./benny-editing-playbooks";

function item(overrides: Partial<BrainItem> = {}): BrainItem {
  const value = editingPlaybookMemory(BENNY_EDITING_PLAYBOOKS[0]);
  return {
    ...value,
    id: "11111111-1111-4111-8111-111111111111",
    sourceUrl: null,
    sourceRef: value.sourceRef ?? null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

describe("Benny editing playbooks", () => {
  it("stores selectable playbooks as valid bounded creator memories", () => {
    expect(new Set(BENNY_EDITING_PLAYBOOKS.map((value) => value.id)).size).toBe(5);
    for (const playbook of BENNY_EDITING_PLAYBOOKS) {
      const memory = brainItemInputSchema.parse(editingPlaybookMemory(playbook));
      expect(memory.content.length).toBeLessThanOrEqual(1000);
      expect(memory.provenance).toBe("creator");
      expect(memory.status).toBe("confirmed");
      expect(memory.tags).toContain(playbook.kind);
    }
  });

  it("reuses only confirmed creator-owned memories and preserves their customization", () => {
    const custom = item({ content: "My own pacing.", locked: true });
    expect(
      savedEditingPlaybook(BENNY_EDITING_PLAYBOOKS[0], [
        item({ provenance: "agent_chat" }),
        item({ status: "suggested" }),
        custom,
      ]),
    ).toBe(custom);
    expect(
      savedEditingPlaybook(BENNY_EDITING_PLAYBOOKS[0], [
        item({ tags: ["creative-preference", "carousel", "playbook:doodle"] }),
      ]),
    ).toBeUndefined();
  });

  it("excludes unconfirmed or unrelated memory and bounds generation context", () => {
    const confirmed = Array.from({ length: 7 }, () => item({ content: "x".repeat(2000) }));
    const context = creativePreferenceContext([
      null,
      "unstructured",
      {
        provenance: "creator",
        status: "confirmed",
        title: "Bad",
        content: "Bad",
        tags: "creative-preference",
      },
      item({ provenance: "social_post" }),
      item({ status: "suggested" }),
      item({ tags: ["reel"] }),
      ...confirmed,
    ]);
    expect(context).toHaveLength(4);
    expect(context.every((entry) => entry.content.length === 1000)).toBe(true);
    expect(context.every((entry) => entry.kind === "reel")).toBe(true);
  });

  it("includes general creative corrections and prioritizes newer edits over older playbooks", () => {
    const old = Array.from({ length: 4 }, (_, i) =>
      item({ title: `Older ${i}`, updatedAt: "2026-11-01T00:00:00Z" }),
    );
    const correction = item({
      title: "Keep my approved copy",
      tags: ["creative-preference"],
      updatedAt: "2026-11-22T00:00:00Z",
    });
    const values = [...old, correction];
    const context = creativePreferenceContext(values, "reel");
    expect(context).toHaveLength(4);
    expect(context[0]).toMatchObject({ title: correction.title, kind: null });
    expect(values[0]).toBe(old[0]);
    expect(creativePreferenceContext([correction], "carousel")[0].title).toBe(correction.title);
    expect(
      creativePreferenceContext([item({ ...correction, status: "suggested" })], "reel"),
    ).toEqual([]);
  });
});

it("selects format-relevant preferences and includes avatar guidance only for Reels", () => {
  const values = [
    item({ tags: ["creative-preference", "reel"] }),
    item({ tags: ["creative-preference", "carousel"] }),
    item({ tags: ["creative-preference", "avatar"] }),
  ];
  expect(creativePreferenceContext(values, "carousel").map((value) => value.kind)).toEqual([
    "carousel",
  ]);
  expect(creativePreferenceContext(values, "reel").map((value) => value.kind)).toEqual([
    "reel",
    "avatar",
  ]);
});
