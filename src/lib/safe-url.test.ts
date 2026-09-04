import { describe, expect, it } from "vitest";
import {
  isPrivateOrReservedHostname,
  parsePublicHttpUrl,
  redactSensitivePathname,
  safeCssColor,
  safeNavigationHref,
  safePublicMediaUrl,
  sanitizeLocalRedirect,
  stripUrlSearchParameters,
  trustedApplicationOrigin,
} from "./safe-url";

describe("safe URL handling", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "[::1]",
    "localhost",
    "service.internal",
    "printer.local",
  ])("rejects private destination %s", (hostname) => {
    expect(isPrivateOrReservedHostname(hostname)).toBe(true);
  });

  it("normalizes and rejects alternate IPv4 encodings", () => {
    expect(parsePublicHttpUrl("http://2130706433/admin")).toBeNull();
    expect(parsePublicHttpUrl("http://0177.0.0.1/admin")).toBeNull();
  });

  it("allows public HTTP links and blocks active URL schemes", () => {
    expect(safeNavigationHref("https://example.com/path")).toBe("https://example.com/path");
    expect(safeNavigationHref("javascript:alert(document.domain)")).toBeNull();
    expect(safeNavigationHref("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("never emits local or private media URLs into public pages", () => {
    expect(safePublicMediaUrl("http://localhost:8080/cdn/avatar.png")).toBeNull();
    expect(safePublicMediaUrl("http://192.168.1.4/avatar.png")).toBeNull();
    expect(safePublicMediaUrl("https://cdn.example.com/avatar.png")).toBe(
      "https://cdn.example.com/avatar.png",
    );
  });

  it("keeps login redirects same-origin", () => {
    expect(sanitizeLocalRedirect("/link?tab=links")).toBe("/link?tab=links");
    expect(sanitizeLocalRedirect("https://evil.example/phish")).toBe("/link");
    expect(sanitizeLocalRedirect("//evil.example/phish")).toBe("/link");
    expect(sanitizeLocalRedirect("/\\evil.example")).toBe("/link");
  });

  it("removes capabilities without dropping harmless success state", () => {
    expect(
      stripUrlSearchParameters(
        "https://app.bento.surf/p/item/success?order=order-1&access=secret#receipt",
        ["access"],
      ),
    ).toBe("/p/item/success?order=order-1#receipt");
  });

  it.each([
    ["/access/private-token", "/access/[redacted]"],
    ["/review/review-token", "/review/[redacted]"],
    ["/payments/razorpay/session-id", "/payments/razorpay/[redacted]"],
    ["/library/receipts/order-id", "/library/receipts/[redacted]"],
    ["/api/commerce/download/token/file", "/api/commerce/download/[redacted]/file"],
    ["/p/product", "/p/product"],
  ])("redacts capability path %s", (input, expected) => {
    expect(redactSensitivePathname(input)).toBe(expected);
  });

  it("allows only data-only CSS colors", () => {
    expect(safeCssColor("#6366f1")).toBe("#6366f1");
    expect(safeCssColor("oklch(62% 0.2 260)")).toBe("oklch(62% 0.2 260)");
    expect(safeCssColor("red; background-image:url(https://attacker.example)")).toBeNull();
    expect(safeCssColor("var(--attacker-controlled)")).toBeNull();
  });

  it("uses only trusted hosts for authentication callbacks", () => {
    expect(trustedApplicationOrigin("https://self.example/login", "https://self.example")).toBe(
      "https://self.example",
    );
    expect(trustedApplicationOrigin("https://creator.example/login")).toBe("http://localhost:8080");
    expect(trustedApplicationOrigin("https://evil.example", "https://self.example")).toBe(
      "https://self.example",
    );
  });
});
