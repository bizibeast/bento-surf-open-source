import { describe, expect, it } from "vitest";
import { extractWidgetUrl, googleMapsEmbedUrl } from "./embeds";

describe("safe embeds", () => {
  it("builds a Google Maps place embed URL", () => {
    expect(googleMapsEmbedUrl("Gateway of India")).toContain("q=Gateway+of+India");
  });

  it("accepts HTTPS URLs and extracts iframe sources", () => {
    expect(extractWidgetUrl('<iframe src="https://widgets.example.com/card?id=1"></iframe>')).toBe(
      "https://widgets.example.com/card?id=1",
    );
  });

  it("rejects scripts, insecure URLs, and local addresses", () => {
    expect(extractWidgetUrl("<script>alert(1)</script>")).toBeNull();
    expect(extractWidgetUrl("http://example.com/widget")).toBeNull();
    expect(extractWidgetUrl("https://localhost/widget")).toBeNull();
    expect(extractWidgetUrl("https://192.168.1.10/widget")).toBeNull();
    expect(extractWidgetUrl("https://172.16.4.5/widget")).toBeNull();
  });
});
