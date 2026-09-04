import { describe, expect, it } from "vitest";
import { resolveMapsOrigin } from "./PersistentMap";

describe("resolveMapsOrigin", () => {
  it("uses the configured public origin", () => {
    expect(
      resolveMapsOrigin(
        "https://staging.example",
        "staging.example",
        "https://public.example/link",
      ),
    ).toBe("https://public.example");
  });

  it("keeps custom-domain maps on the configured public origin", () => {
    expect(
      resolveMapsOrigin("https://creator.example", "creator.example", "https://public.example"),
    ).toBe("https://public.example");
  });

  it("keeps local development on its current origin", () => {
    expect(resolveMapsOrigin("http://localhost:8080", "localhost", "https://public.example")).toBe(
      "http://localhost:8080",
    );
  });

  it("fails closed to the local-safe origin for invalid configuration", () => {
    expect(resolveMapsOrigin("https://evil.example", "evil.example", "not a url")).toBe(
      "http://localhost:8080",
    );
  });
});
