import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const CHECKED_EXTENSIONS = new Set([".css", ".md", ".ts", ".tsx"]);

function collectFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(path);
    return CHECKED_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

describe("design quality guardrails", () => {
  it("does not use em dashes in product copy or documentation", () => {
    const emDash = String.fromCodePoint(0x2014);
    const offenders = ["src", "docs"]
      .flatMap(collectFiles)
      .filter((file) => readFileSync(file, "utf8").includes(emDash));

    expect(offenders).toEqual([]);
  });
});
