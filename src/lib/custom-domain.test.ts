import { describe, expect, it } from "vitest";
import {
  hostnameFromRequestHost,
  isConfiguredInstanceHostname,
  normalizeHostname,
} from "./custom-domain";

describe("normalizeHostname", () => {
  it("normalizes a hostname and an origin URL", () => {
    expect(normalizeHostname(" Links.Example.COM. ")).toBe("links.example.com");
    expect(normalizeHostname("https://links.example.com/ ")).toBe("links.example.com");
  });

  it.each(["localhost", "example.com/path", "bad_domain.com", "https://example.com/a", "a.test"])(
    "rejects %s",
    (value) => expect(() => normalizeHostname(value)).toThrow(),
  );
});

describe("hostnameFromRequestHost", () => {
  it("removes a port and normalizes case", () => {
    expect(hostnameFromRequestHost("Portfolio.Example.com:8080")).toBe("portfolio.example.com");
  });
});

describe("configured instance hostname protection", () => {
  const env = {
    VITE_APP_URL: "https://app.self.example",
    VITE_PUBLIC_URL: "https://public.self.example",
  };

  it("reserves the configured app and public hostnames only", () => {
    expect(isConfiguredInstanceHostname("app.self.example", env)).toBe(true);
    expect(isConfiguredInstanceHostname("public.self.example", env)).toBe(true);
    expect(isConfiguredInstanceHostname("creator.example.com", env)).toBe(false);
  });
});
