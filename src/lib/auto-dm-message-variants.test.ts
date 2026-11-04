import { describe, expect, it } from "vitest";
import {
  autoDmLinkButton,
  hasAutoDmNameToken,
  personalizeAutoDmText,
  selectAutoDmMessage,
} from "./auto-dm-message-variants";

describe("Meta Auto-DM message copy", () => {
  it("selects one stable approved option for webhook retries", () => {
    const options = ["Here is your guide", "I have your guide", "Your guide is ready"];
    const selected = selectAutoDmMessage(options, "fallback", "comment-123");
    expect(options).toContain(selected);
    expect(selectAutoDmMessage(options, "fallback", "comment-123")).toBe(selected);
    expect(selectAutoDmMessage([], "fallback", "comment-123")).toBe("fallback");
  });

  it("moves a legacy text URL into a secure link button", () => {
    expect(autoDmLinkButton("Guide: https://example.com/guide", null, null)).toEqual({
      text: "Guide:",
      url: "https://example.com/guide",
      label: "Open link",
    });
    expect(autoDmLinkButton("See http://example.com", null, null).url).toBeNull();
    expect(autoDmLinkButton("Guide at www.example.com.", null, null)).toMatchObject({
      text: "Guide at",
      url: "https://www.example.com",
    });
  });

  it("uses a safe recipient name and a natural fallback", () => {
    expect(hasAutoDmNameToken(["Hi {{name}}", null])).toBe(true);
    expect(personalizeAutoDmText("Hi {{name}}, thanks!", "Maya Patel")).toBe("Hi Maya, thanks!");
    expect(personalizeAutoDmText("Hi {{first_name}}, thanks!", null)).toBe("Hi there, thanks!");
    expect(personalizeAutoDmText("Hi {{name}}", "https://bad.example")).toBe("Hi there");
  });
});
