import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/routes/$username_.products.$productSlug.tsx"),
  "utf8",
);

function toolSource(name: string, next: string) {
  const start = source.indexOf(`name: "${name}"`);
  const end = source.indexOf(next, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("public product WebMCP contracts", () => {
  it("bounds public lessons and reports the total", () => {
    const block = toolSource("bento_get_public_product", "useWebMcpTools(webMcpTools)");
    expect(block).toContain("lessonCount: lessons.length");
    expect(block).toContain("lessons: lessons.slice(0, 100).map");
  });

  it("matches commerce customer and answer limits and marks creator copy untrusted", () => {
    const properties = source.slice(
      source.indexOf("const customerProperties"),
      source.indexOf("const applyInputs"),
    );
    expect(properties).toContain("maxLength: 254");
    expect(properties).toContain("maxLength: 120");
    expect(properties).toContain('product.kind === "lead_form" ? 100 : 40');
    expect(properties).toContain('additionalProperties: { type: "string", maxLength: 5_000 }');
    expect(properties).toContain("maxProperties: 20");
    expect(properties).toContain('"x-maxSerializedLength": 50_000');
    expect(properties).toContain("maxLength: 32");

    const lead = toolSource("bento_submit_lead_form", 'name: "bento_open_affiliate_offer"');
    expect(lead).toContain("untrustedContentHint: true");
  });

  it.each([
    ["bento_prepare_checkout", 'name: "bento_submit_lead_form"', "previewCommerceCheckout"],
    ["bento_submit_lead_form", 'name: "bento_open_affiliate_offer"', "submitCommerceLead"],
    ["bento_open_affiliate_offer", 'name: "bento_start_checkout"', "recordCommerceAffiliateClick"],
    ["bento_start_checkout", "return tools", "createCommerceCheckout"],
  ])("checks cancellation around %s side effects", (name, next, dispatch) => {
    const block = toolSource(name, next);
    const firstAbort = block.indexOf("signal?.throwIfAborted();");
    const dispatchAt = block.indexOf(dispatch);
    const lastAbort = block.lastIndexOf("signal?.throwIfAborted();");

    expect(block).toContain("execute: async (input, { signal })");
    expect(firstAbort).toBeGreaterThan(-1);
    expect(firstAbort).toBeLessThan(dispatchAt);
    expect(lastAbort).toBeGreaterThan(dispatchAt);
  });
});
