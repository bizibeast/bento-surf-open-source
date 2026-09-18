import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  OPEN_SOURCE_ALL_TEXT_RULES,
  OPEN_SOURCE_IDENTITY_RULES,
  OPEN_SOURCE_TEST_FILE,
} from "./check-open-source-boundary";

export type HistoryViolation = { object: string; file: string; reason: string };

const run = promisify(execFile);
const TEXT_FILE = /\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|toml|md|txt|env|html?|css)$/i;

function historyObject(line: string) {
  const separator = line.indexOf(" ");
  if (separator === -1) return null;
  const object = line.slice(0, separator);
  const file = line.slice(separator + 1);
  if (!/^[a-f0-9]{40}$/.test(object) || (!TEXT_FILE.test(file) && file !== ".env.example")) {
    return null;
  }
  return { object, file };
}

export async function checkOpenSourceHistory(root: string): Promise<HistoryViolation[]> {
  const repository = resolve(root);
  const { stdout } = await run("git", ["-C", repository, "rev-list", "--objects", "--all"]);
  const objects = stdout
    .split("\n")
    .map(historyObject)
    .filter((value): value is NonNullable<typeof value> => Boolean(value));
  const seen = new Set<string>();
  const findings: HistoryViolation[] = [];

  for (const item of objects) {
    const key = `${item.object}:${item.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let contents: string;
    try {
      ({ stdout: contents } = await run(
        "git",
        ["-C", repository, "cat-file", "blob", item.object],
        { maxBuffer: 2 * 1024 * 1024 },
      ));
    } catch {
      continue;
    }
    const rules = OPEN_SOURCE_TEST_FILE.test(item.file)
      ? OPEN_SOURCE_ALL_TEXT_RULES
      : [...OPEN_SOURCE_ALL_TEXT_RULES, ...OPEN_SOURCE_IDENTITY_RULES];
    for (const { reason, pattern } of rules) {
      if (pattern.test(contents)) {
        findings.push({ object: item.object.slice(0, 12), file: item.file, reason });
      }
    }
  }

  return findings
    .filter(
      (finding, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.object === finding.object &&
            candidate.file === finding.file &&
            candidate.reason === finding.reason,
        ) === index,
    )
    .sort(
      (left, right) =>
        left.file.localeCompare(right.file) ||
        left.reason.localeCompare(right.reason) ||
        left.object.localeCompare(right.object),
    );
}

if (import.meta.main) {
  const violations = await checkOpenSourceHistory(process.cwd());
  for (const violation of violations) {
    console.log(`${violation.object} ${violation.file}: ${violation.reason}`);
  }
  if (violations.length) process.exitCode = 1;
}
