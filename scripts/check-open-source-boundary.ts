import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

export type BoundaryViolation = { file: string; reason: string };

const EXCLUDED_PATHS = [
  ".github/workflows/put-",
  "help-center/",
  "public/marketing/",
  "src/components/marketing/",
  "src/routes/alternatives.",
  "src/routes/compare.",
  "src/routes/features.",
  "src/routes/tools.",
  "src/routes/use-cases.",
] as const;

const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "out",
  "tmp",
  "temp",
]);
const TEXT_FILE = /\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|toml|md|txt|env|html?|css)$/i;
const ENV_EXAMPLE_FILE = /(?:^|[/\\])\.env\.example$/i;
const TEST_FILE = /\.(?:test|spec)\.[^/]+$/i;
const brand = ["ben", "to"].join("");
const domain = ["sur", "f"].join("");

const ALL_TEXT_RULES: Array<{ reason: string; pattern: RegExp }> = [
  {
    reason: "credential-shaped secret",
    pattern:
      /\b(?:sk|rk|pk)_(?:live|prod)_[A-Za-z0-9_-]{16,}\b|\b(?:sb_secret_|whsec_|xox[baprs]-|gh[pousr]_)[A-Za-z0-9_-]{16,}\b|\bAKIA[A-Z0-9]{16}\b/,
  },
  {
    reason: "hard-coded Supabase project configuration",
    pattern:
      /(?:^|\n)\s*project_id\s*=\s*["'][a-z0-9]{20}["']|\b(?:VITE_)?SUPABASE_PROJECT_ID\s*[:=]\s*["'][a-z0-9]{20}["']/i,
  },
  {
    reason: "populated example secret",
    pattern:
      /(?:^|\n)[ \t]*(?!WEBMCP_(?:APP_|PUBLIC_)?ORIGIN_TRIAL_TOKEN\b)[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|SERVICE_ROLE_KEY)[A-Z0-9_]*[ \t]*=[ \t]*(?!(?:your_|replace|placeholder|changeme)?[ \t]*(?:\n|$))[^\s#]+/,
  },
];

const TEXT_RULES: Array<{ reason: string; pattern: RegExp }> = [
  {
    reason: "private production identity",
    pattern: new RegExp(`https?:\\/\\/(?:[a-z0-9-]+\\.)?${brand}\\.${domain}\\b`, "i"),
  },
  {
    reason: "private production identity",
    pattern: new RegExp(`(?:\\b[a-z0-9-]+\\.|\\.)${brand}\\.${domain}\\b`, "i"),
  },
  { reason: "hard-coded Supabase project URL", pattern: /https:\/\/[a-z0-9-]+\.supabase\.co\b/i },
  {
    reason: "personal identity marker",
    pattern:
      /\b[A-Z0-9._%+-]+@(?!example\.(?:com|net|org)\b|[^\s"'\x60]+\.(?:test|invalid)\b|localhost\b)[A-Z0-9.-]+\.[A-Z]{2,}\b|\bEXPLORE_EXCLUDED_USERNAMES\s*=\s*new Set\s*\(\s*\[\s*["']|\b(?:author|maintainer|owner)\s*[:=]\s*["']?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/i,
  },
  {
    reason: "provider fallback identity",
    pattern:
      /\b(?!(?:do|ws)\.featurebase\.app\b)[a-z0-9-]+\.featurebase\.app\b|\b(?:VITE_FEATUREBASE_APP_ID|featurebaseAppId)\b[^\n]{0,80}(?:\|\||\?\?)[^\n]{0,20}["'][a-f0-9]{20,}["']/i,
  },
  {
    reason: "populated Origin Trial token",
    pattern:
      /(?:\bWEBMCP_(?:APP_|PUBLIC_)?ORIGIN_TRIAL_TOKEN[ \t]*[:=][ \t]*["']?[A-Za-z0-9_-]{20,}|\borigin[_-]?trial[_-]?token[ \t]*[:=][ \t]*["'][A-Za-z0-9_-]{20,}["'])/i,
  },
  {
    reason: "non-empty example secret",
    pattern:
      /\b(?:example|sample|demo)[A-Z0-9_]*(?:secret|token|key|password)[A-Z0-9_]*\s*[:=]\s*["']?(?!your_|replace|placeholder|changeme)[^\s"'`]{8,}/i,
  },
];

function toRelativePath(root: string, file: string) {
  return relative(root, file).split(sep).join("/");
}

function isPublicTextFile(file: string) {
  return TEXT_FILE.test(file) || ENV_EXAMPLE_FILE.test(file);
}

const run = promisify(execFile);

async function trackedFiles(root: string): Promise<string[] | null> {
  let stdout: string;
  try {
    ({ stdout } = await run("git", ["-C", root, "rev-parse", "--is-inside-work-tree"]));
  } catch {
    return null;
  }

  if (stdout.trim() !== "true") return null;
  const listed = await run("git", ["-C", root, "ls-files", "-z"]);
  return listed.stdout
    .split("\0")
    .filter(isPublicTextFile)
    .map((file) => resolve(root, file));
}

async function findFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = `${directory}${sep}${entry.name}`;
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) files.push(...(await findFiles(path)));
    } else if (entry.isFile() && isPublicTextFile(entry.name)) {
      files.push(path);
    }
  }

  return files;
}

export async function checkOpenSourceBoundary(root: string): Promise<BoundaryViolation[]> {
  const absoluteRoot = resolve(root);
  const violations: BoundaryViolation[] = [];

  for (const file of (await trackedFiles(absoluteRoot)) ?? (await findFiles(absoluteRoot))) {
    const relativeFile = toRelativePath(absoluteRoot, file);
    if (EXCLUDED_PATHS.some((path) => relativeFile.startsWith(path))) {
      violations.push({ file: relativeFile, reason: "excluded marketing path" });
      continue;
    }

    const contents = await readFile(file, "utf8");
    for (const { reason, pattern } of ALL_TEXT_RULES) {
      if (pattern.test(contents)) violations.push({ file: relativeFile, reason });
    }
    if (TEST_FILE.test(relativeFile)) continue;
    for (const { reason, pattern } of TEXT_RULES) {
      if (pattern.test(contents)) violations.push({ file: relativeFile, reason });
    }
  }

  return violations
    .filter(
      (violation, index, all) =>
        all.findIndex(
          (candidate) => candidate.file === violation.file && candidate.reason === violation.reason,
        ) === index,
    )
    .sort(
      (left, right) =>
        left.file.localeCompare(right.file) || left.reason.localeCompare(right.reason),
    );
}

if (import.meta.main) {
  const violations = await checkOpenSourceBoundary(process.cwd());
  for (const { file, reason } of violations) console.log(`${file}: ${reason}`);
  if (violations.length) process.exitCode = 1;
}
