import { describe, expect, it } from "vitest";
import { parseSuggestions } from "./auto-dm-copy-assistant.functions";

const response = (alternatives: string[]) => ({
  choices: [{ message: { content: JSON.stringify({ alternatives }) } }],
});

describe("Auto-DM copy suggestions", () => {
  it("accepts two distinct, link-free draft alternatives", () => {
    expect(
      parseSuggestions(
        response(["Your guide is ready", "I have the guide ready"]),
        "Here is your guide",
        300,
      ),
    ).toEqual(["Your guide is ready", "I have the guide ready"]);
  });

  it("rejects links and duplicate suggestions before they reach the editor", () => {
    expect(() =>
      parseSuggestions(
        response(["See https://example.com", "Your guide is ready"]),
        "Here is your guide",
        300,
      ),
    ).toThrow("need review");
    expect(() =>
      parseSuggestions(
        response(["Here is your guide", "Your guide is ready"]),
        "Here is your guide",
        300,
      ),
    ).toThrow("need review");
  });
});
