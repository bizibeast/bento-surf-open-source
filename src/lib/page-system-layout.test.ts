import { describe, expect, it } from "vitest";
import {
  defaultSystemItemLayout,
  mergeSystemItemLayout,
  type SystemPageItem,
} from "./page-system-layout";

const intro: SystemPageItem = {
  key: "intro",
  pageId: "page",
  system: "calendar",
  kind: "intro",
  title: "Calendar",
  data: {},
  defaultW: 4,
  defaultH: 2,
};
const sessionA: SystemPageItem = { ...intro, key: "session:a", kind: "session" };
const sessionB: SystemPageItem = { ...sessionA, key: "session:b" };

describe("system item layout", () => {
  it("rejects more than 200 source items without truncating", () => {
    const items = [
      intro,
      ...Array.from({ length: 200 }, (_, index) => ({
        ...sessionA,
        key: `session:${index}`,
      })),
    ];
    expect(() => defaultSystemItemLayout(items)).toThrow("System pages support at most 200 items.");
  });
  it("reuses a legal gap below tall saved tiles", () => {
    const sources = Array.from({ length: 11 }, (_, index) => ({
      ...sessionA,
      key: `session:${index}`,
    })).filter((_, index) => index !== 5);
    const saved = sources.map((source, position) => ({
      itemKey: source.key,
      x: 0,
      y: Number(source.key.split(":")[1]) * 1000,
      w: 8,
      h: 1000,
      position,
    }));
    expect(mergeSystemItemLayout([...sources, intro], saved).at(-1)).toEqual({
      itemKey: "intro",
      x: 0,
      y: 5000,
      w: 4,
      h: 2,
      position: 10,
    });
  });
  it("rejects a fully occupied valid range instead of generating y 11000", () => {
    const sources = Array.from({ length: 11 }, (_, index) => ({
      ...sessionA,
      key: `session:${index}`,
    }));
    const saved = sources.map((source, position) => ({
      itemKey: source.key,
      x: 0,
      y: position * 1000,
      w: 8,
      h: 1000,
      position,
    }));
    expect(() => mergeSystemItemLayout([...sources, intro], saved)).toThrow(
      "System page layout has no available space within the supported grid.",
    );
  });
  it("packs defaults deterministically in the existing eight-column grid", () => {
    expect(defaultSystemItemLayout([intro, sessionA, sessionB], 8)).toEqual([
      { itemKey: "intro", x: 0, y: 0, w: 4, h: 2, position: 0 },
      { itemKey: "session:a", x: 4, y: 0, w: 4, h: 2, position: 1 },
      { itemKey: "session:b", x: 0, y: 2, w: 4, h: 2, position: 2 },
    ]);
  });
  it("keeps saved positions and appends newly published items", () => {
    expect(
      mergeSystemItemLayout(
        [intro, sessionA, sessionB],
        [{ itemKey: "session:a", x: 4, y: 0, w: 4, h: 2, position: 0 }],
        8,
      ),
    ).toEqual([
      { itemKey: "session:a", x: 4, y: 0, w: 4, h: 2, position: 0 },
      { itemKey: "intro", x: 0, y: 0, w: 4, h: 2, position: 1 },
      { itemKey: "session:b", x: 0, y: 2, w: 4, h: 2, position: 2 },
    ]);
  });
  it("ignores stale source rows", () => {
    expect(
      mergeSystemItemLayout(
        [intro],
        [{ itemKey: "product:deleted", x: 0, y: 20, w: 4, h: 2, position: 0 }],
        8,
      ),
    ).toEqual([{ itemKey: "intro", x: 0, y: 0, w: 4, h: 2, position: 0 }]);
  });
  it("rejects duplicate source and saved keys", () => {
    expect(() => defaultSystemItemLayout([intro, intro], 8)).toThrow(/unique/i);
    const saved = { itemKey: "intro", x: 0, y: 0, w: 4, h: 2, position: 0 };
    expect(() => mergeSystemItemLayout([intro], [saved, saved], 8)).toThrow(/unique/i);
  });
  it("compacts order gaps so new items remain within the 200-item save boundary", () => {
    expect(
      mergeSystemItemLayout(
        [intro, sessionA],
        [{ itemKey: "session:a", x: 4, y: 4, w: 4, h: 2, position: 199 }],
        8,
      ),
    ).toEqual([
      { itemKey: "session:a", x: 4, y: 4, w: 4, h: 2, position: 0 },
      { itemKey: "intro", x: 0, y: 0, w: 4, h: 2, position: 1 },
    ]);
  });
  it("fits narrower grids without collisions and retains saved order", () => {
    expect(defaultSystemItemLayout([intro, sessionA], 2)).toEqual([
      { itemKey: "intro", x: 0, y: 0, w: 2, h: 2, position: 0 },
      { itemKey: "session:a", x: 0, y: 2, w: 2, h: 2, position: 1 },
    ]);
    expect(
      mergeSystemItemLayout(
        [intro, sessionA],
        [
          { itemKey: "session:a", x: 0, y: 6, w: 4, h: 2, position: 3 },
          { itemKey: "intro", x: 0, y: 0, w: 4, h: 2, position: 1 },
        ],
        8,
      ).map((item) => item.itemKey),
    ).toEqual(["intro", "session:a"]);
  });
});
