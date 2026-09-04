import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("package scripts", () => {
  it("references only present local files and installed executables", async () => {
    const root = resolve(import.meta.dirname, "..");
    const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const missing: string[] = [];

    for (const [name, command] of Object.entries(packageJson.scripts)) {
      for (const segment of command.split(/\s*&&\s*/)) {
        const [runner, argument] = segment.trim().split(/\s+/);
        const target =
          (runner === "bun" || runner === "node") && argument?.startsWith("scripts/")
            ? resolve(root, argument)
            : runner !== "bun" && runner !== "node"
              ? resolve(root, "node_modules/.bin", runner)
              : null;
        if (target) {
          await access(target).catch(() => missing.push(name + ": " + (argument || runner)));
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
