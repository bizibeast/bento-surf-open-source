import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/routes/_authenticated/link.tsx"), "utf8");

describe("link editor creator font scope", () => {
  it("keeps creator fonts on rendered creator blocks instead of editor chrome", () => {
    expect(source.match(/style=\{creatorFontVars\}/gu)).toHaveLength(1);
    expect(source).toContain('<div style={creatorFontVars} className="contents">');
  });
});
