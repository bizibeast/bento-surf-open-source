import { describe, expect, it } from "vitest";
import { jsonLdScript } from "./seo-structured-data";

describe("SEO structured data", () => {
  it("escapes user-controlled closing tags before JSON-LD reaches HTML", () => {
    const script = jsonLdScript({ "@type": "Thing", name: "</script><script>alert(1)</script>" });
    expect(script.children).not.toContain("</script>");
    expect(script.children).toContain("\\u003c/script>");
  });
});
