import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const creatorSurfaces = [
  "routes/$username_.store.tsx",
  "routes/$username_.products.$productSlug.tsx",
  "routes/$username_.products.$productSlug_.success.tsx",
  "routes/access.$token.tsx",
];

describe("creator-owned commerce typography", () => {
  it.each(creatorSurfaces)("applies the creator fonts on %s", async (path) => {
    const source = await readFile(resolve(process.cwd(), "src", path), "utf8");
    expect(source).toContain('import { FontApplier } from "@/components/FontApplier"');
    expect(source).toContain("<FontApplier");
  });

  it("returns creator font choices from every commerce profile query", async () => {
    const source = await readFile(resolve(process.cwd(), "src/lib/commerce.functions.ts"), "utf8");
    expect(source.match(/primary_font, secondary_font/g)).toHaveLength(3);
  });
});
