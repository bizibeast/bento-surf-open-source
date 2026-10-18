import { execFile } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkOpenSourceHistory,
  reviewedHistoricalIdentityContents,
} from "./check-open-source-history";

const run = promisify(execFile);
const roots: string[] = [];

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "bento-history-"));
  roots.push(root);
  await run("git", ["init", "--quiet"], { cwd: root });
  await run("git", ["config", "user.email", "maintainer@example.com"], { cwd: root });
  await run("git", ["config", "user.name", "Example Maintainer"], { cwd: root });
  return root;
}

async function commit(root: string, message: string) {
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["commit", "--quiet", "-m", message], { cwd: root });
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

describe("open-source Git history", () => {
  it("finds a credential removed from the current tree without printing its value", async () => {
    const root = await repository();
    const credential = ["sk", "live", "abcdefghijklmnopqrstuvwxyz"].join("_");
    await writeFile(join(root, "runtime.ts"), `export const token = "${credential}";\n`);
    await commit(root, "add runtime");
    await unlink(join(root, "runtime.ts"));
    await writeFile(join(root, "safe.ts"), "export const safe = true;\n");
    await commit(root, "remove runtime");

    const findings = await checkOpenSourceHistory(root);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: "runtime.ts", reason: "credential-shaped secret" });
    expect(findings[0]?.object).toMatch(/^[a-f0-9]{12}$/);
    expect(JSON.stringify(findings)).not.toContain(credential);
  });

  it("accepts a clean repository", async () => {
    const root = await repository();
    await writeFile(join(root, "safe.ts"), "export const safe = true;\n");
    await commit(root, "safe source");

    await expect(checkOpenSourceHistory(root)).resolves.toEqual([]);
  });
});

it("limits the reviewed legacy fallback exception to its exact blob and path", () => {
  const object = "e2273b116de932b6099f7059169ff1b17298305c";
  const file = "src/lib/twitter-auto-dm.server.ts";
  const origin = ["https://app", "bento", "surf"].join(".");
  const input = `const fallback = "${origin}"; const other = "https://another.example";`;
  expect(reviewedHistoricalIdentityContents(object, file, input)).toContain(
    '"http://localhost:8080"',
  );
  expect(reviewedHistoricalIdentityContents("0".repeat(40), file, input)).toBe(input);
  expect(reviewedHistoricalIdentityContents(object, "src/other.ts", input)).toBe(input);
  expect(reviewedHistoricalIdentityContents(object, file, input)).toContain(
    "https://another.example",
  );
});

it("preserves credential contents even in the reviewed legacy blob", () => {
  const credential = ["sk", "live", "abcdefghijklmnopqrstuvwxyz"].join("_");
  expect(
    reviewedHistoricalIdentityContents(
      "e2273b116de932b6099f7059169ff1b17298305c",
      "src/lib/twitter-auto-dm.server.ts",
      credential,
    ),
  ).toBe(credential);
});
