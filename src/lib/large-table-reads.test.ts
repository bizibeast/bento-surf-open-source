import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const TABLES = [
  "creator_content_media",
  "social_content_insights",
  "creator_brain_items",
  "creator_content_profiles",
  "social_connections",
];
const STAR = /\.select\s*\(\s*["'`]\s*\*\s*["'`]/;
const EMBED_STAR = new RegExp(`(?:${TABLES.join("|")})\\(\\s*\\*\\s*\\)`);
const BOUND = /\.(?:limit|range|maybeSingle|single)\s*\(|\bhead\s*:\s*true/;
const WRITE = /\.(?:insert|update|upsert|delete)\s*\(/;

type Violation = { file: string; line: number; table: string; kind: "star" | "unbounded" };

function strip(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

function chainFrom(source: string, index: number) {
  let depth = 0;
  let end = index;
  for (; end < source.length; end++) {
    const char = source[end];
    if (char === "(") depth++;
    else if (char === ")") {
      depth--;
      if (depth < 0) break;
    } else if (depth === 0 && (char === "," || char === ";")) break;
  }
  return source.slice(index, end);
}

function lineOf(source: string, index: number) {
  return source.slice(0, index).split("\n").length;
}

function assignedName(source: string, index: number) {
  const prior = source.slice(Math.max(0, index - 700), index);
  const cut = Math.max(prior.lastIndexOf(";"), prior.lastIndexOf("{"), prior.lastIndexOf("}"));
  const names = [...prior.slice(cut + 1).matchAll(/(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=/g)];
  return names.at(-1)?.[1] ?? null;
}

function laterBound(source: string, index: number, name: string | null) {
  if (!name) return false;
  const lines: string[] = [];
  for (const line of source.slice(index).split("\n")) {
    if (lines.length && /^(?:export |async function |function )/.test(line)) break;
    lines.push(line);
    if (lines.length >= 90) break;
  }
  const text = lines.join("\n");
  const bound = new RegExp(
    `\\b${name}\\b(?:\\s*=\\s*${name}\\b)?(?:\\s*\\.\\s*\\w+\\([^;]*\\))*\\s*\\.\\s*(?:limit|range|maybeSingle|single)\\s*\\(`,
  );
  return bound.test(text);
}

export function findLargeTableReadViolations(source: string, file = "fixture.ts"): Violation[] {
  const stripped = strip(source);
  const hits: Violation[] = [];
  const fromRe = new RegExp(`\\.from\\(\\s*["'\`](${TABLES.join("|")})["'\`]`, "g");
  let match: RegExpExecArray | null;
  while ((match = fromRe.exec(stripped))) {
    const chain = chainFrom(stripped, match.index);
    const write = WRITE.test(chain);
    const star = (STAR.test(chain) || EMBED_STAR.test(chain)) && !/head\s*:\s*true/.test(chain);
    const bound =
      BOUND.test(chain) ||
      laterBound(stripped, match.index + chain.length, assignedName(stripped, match.index));
    const line = lineOf(stripped, match.index);
    if (star) hits.push({ file, line, table: match[1], kind: "star" });
    if (!write && !bound && /\.select\s*\(/.test(chain)) {
      hits.push({ file, line, table: match[1], kind: "unbounded" });
    }
  }
  const embed = new RegExp(`(?:${TABLES.join("|")})\\(\\s*\\*\\s*\\)`, "g");
  while ((match = embed.exec(stripped))) {
    hits.push({
      file,
      line: lineOf(stripped, match.index),
      table: match[0].replace(/\(.*/, ""),
      kind: "star",
    });
  }
  return hits;
}

function sourceFiles(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules") sourceFiles(path, out);
    } else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

describe("large table reads", () => {
  it("flags select star and reads with no limit, range, or single-row bound", () => {
    const source = `
      db.from("social_content_insights").select("*").eq("user_id", id);
      db.from("creator_brain_items").select("id,title").eq("user_id", id);
      db.from("social_connections").select("*", { count: "exact", head: true });
      let query = db.from("social_connections").select("id").eq("user_id", id);
      await query.maybeSingle();
      db.from("social_post_targets").select("*, connection:social_connections(*)").maybeSingle();
    `;
    const hits = findLargeTableReadViolations(source);
    expect(hits.filter((hit) => hit.kind === "star").map((hit) => hit.table)).toEqual([
      "social_content_insights",
      "social_connections",
    ]);
    expect(hits.filter((hit) => hit.kind === "unbounded").map((hit) => hit.table)).toEqual([
      "social_content_insights",
      "creator_brain_items",
    ]);
  });

  it("keeps user-scoped large tables off unbounded and select-star reads", () => {
    const root = join(import.meta.dirname, "..");
    const hits = sourceFiles(root).flatMap((file) =>
      findLargeTableReadViolations(readFileSync(file, "utf8"), file.slice(root.length + 1)),
    );
    expect(hits).toEqual([]);
  });
});
