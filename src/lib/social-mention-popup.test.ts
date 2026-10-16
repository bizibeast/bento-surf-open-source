import { describe, expect, it } from "vitest";
import { socialMentionPopupPlacement } from "./social-mention-popup";

describe("mention picker placement", () => {
  it.each([
    { width: 360, bottom: 720, caretLeft: 70, caretBottom: 250 },
    { width: 768, bottom: 900, caretLeft: 520, caretBottom: 400 },
    { width: 1280, bottom: 850, caretLeft: 640, caretBottom: 690 },
  ])(
    "keeps the picker below @ on a $width px layout",
    ({ width, bottom, caretLeft, caretBottom }) => {
      const dialog = { left: 0, top: 20, bottom, width };
      const placement = socialMentionPopupPlacement(
        { left: caretLeft, bottom: caretBottom },
        dialog,
        bottom,
      );
      expect(placement.top + dialog.top).toBe(caretBottom + 6);
      expect(placement.left).toBeGreaterThanOrEqual(12);
      expect(placement.left + placement.width).toBeLessThanOrEqual(width - 12);
      expect(placement.maxHeight).toBeGreaterThan(0);
    },
  );

  it("shrinks the picker when the mobile keyboard reduces the visible viewport", () => {
    const placement = socialMentionPopupPlacement(
      { left: 120, bottom: 550 },
      { left: 0, top: 0, bottom: 800, width: 375 },
      610,
    );
    expect(placement.top).toBe(556);
    expect(placement.maxHeight).toBe(48);
  });
});
