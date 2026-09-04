import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  configuredAppOrigin,
  configuredMcpEndpoint,
  configuredPublicOrigin,
  normalizeOrigin,
  normalizePublicUsername,
  publicCreatorPath,
  publicNewsletterIssuePath,
  publicNewsletterPostPath,
  publicNewsletterPublicationPath,
  publicNewslettersPath,
  publicNewsletterPath,
  publicProductPath,
  publicProductSuccessPath,
  publicProductUrl,
  publicProfilePath,
  publicProfileUrl,
  publicStorePath,
} from "./application-urls";

describe("application URLs", () => {
  it("uses local-safe defaults and normalizes configured origins", () => {
    expect(configuredAppOrigin()).toBe("http://localhost:8080");
    expect(configuredPublicOrigin()).toBe("http://localhost:8080");
    expect(configuredAppOrigin("https://self.example/path")).toBe("https://self.example");
    expect(configuredPublicOrigin("https://public.example/path")).toBe("https://public.example");
    expect(configuredMcpEndpoint("https://self.example")).toBe("https://self.example/mcp");
  });

  it("builds collision-free public profile and page URLs", () => {
    expect(publicProfilePath("Explore")).toBe("/@explore");
    expect(publicProfilePath("@Creator", "My Links")).toBe("/@creator/My%20Links");
    expect(publicProfileUrl("Creator", "calendar", "https://public.example/")).toBe(
      "https://public.example/@creator/calendar",
    );
  });

  it("normalizes origins and route parameters safely", () => {
    expect(normalizeOrigin("not a URL", "https://public.example")).toBe("https://public.example");
    expect(normalizePublicUsername("@BiZiBeast")).toBe("bizibeast");
  });

  it("keeps creator-owned resources under the normalized username", () => {
    expect(publicCreatorPath("@Alice", "calendar")).toBe("/@alice/calendar");
    expect(publicStorePath("@Alice")).toBe("/@alice/store");
    expect(publicNewsletterPath("ari")).toBe("/@ari/newsletter");
    expect(publicNewsletterIssuePath("ari", "launch-day")).toBe("/@ari/newsletter/launch-day");
    expect(publicProductPath("@Alice", "Launch Kit")).toBe("/@alice/products/Launch%20Kit");
    expect(publicProductSuccessPath("Alice", "launch-kit")).toBe(
      "/@alice/products/launch-kit/success",
    );
    expect(publicProductUrl("Alice", "launch-kit", "https://public.example/")).toBe(
      "https://public.example/@alice/products/launch-kit",
    );
  });

  it("builds canonical publication and post paths", () => {
    expect(publicNewslettersPath("yash")).toBe("/@yash/newsletters");
    expect(publicNewsletterPublicationPath("yash", "signal")).toBe("/@yash/newsletters/signal");
    expect(publicNewsletterPostPath("yash", "signal", "welcome")).toBe(
      "/@yash/newsletters/signal/welcome",
    );
  });

  it("keeps shared deployment configuration free of operated hostnames", () => {
    for (const file of [
      "src/lib/application-urls.ts",
      "src/lib/deployment-environment.server.ts",
      "vite.config.ts",
      "scripts/verify-deployment-env.ts",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/https?:\/\/(?:[a-z0-9-]+\.)?bento\.surf\b/i);
      expect(source, file).not.toMatch(/https:\/\/[a-z0-9-]+\.supabase\.co\b/i);
    }
  });

  it("keeps operator UI copy free of a fixed deployment name", () => {
    for (const file of [
      "src/lib/payment-providers.ts",
      "src/routes/_authenticated/admin.tsx",
      "src/routes/_authenticated/store.tsx",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/\b(?:[a-z0-9-]+\.)?bento\.surf\b|\bBento\b/i);
    }
  });
});
