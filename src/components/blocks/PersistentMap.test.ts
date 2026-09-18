import { describe, expect, it } from "vitest";
import { resolveMapsOrigin } from "./PersistentMap";

describe("resolveMapsOrigin", () => {
  it("uses the configured staging origin", () => {
    expect(
      resolveMapsOrigin(
        "http://localhost:8080",
        "staging.example.com",
        "http://localhost:8080/link",
      ),
    ).toBe("http://localhost:8080");
  });

  it("keeps custom-domain maps on Bento's restricted production origin", () => {
    expect(
      resolveMapsOrigin("https://creator.example", "creator.example", "http://localhost:8080"),
    ).toBe("http://localhost:8080");
  });

  it("keeps local development on its current origin", () => {
    expect(resolveMapsOrigin("http://localhost:8080", "localhost", "http://localhost:8080")).toBe(
      "http://localhost:8080",
    );
  });

  it("fails closed to the production origin for invalid configuration", () => {
    expect(resolveMapsOrigin("https://evil.example", "evil.example", "not a url")).toBe(
      "http://localhost:8080",
    );
  });
});
