import { describe, expect, it } from "vitest";
import { getContentProviderAdapter } from "./content-provider-adapters.server";

describe("Content provider adapter registry", () => {
  it("routes each knowledge provider to its official adapter", () => {
    for (const provider of ["notion", "granola", "github", "slack"] as const) {
      expect(getContentProviderAdapter(provider).provider).toBe(provider);
    }
  });
});
