import { completeContentStrategy } from "../content-brain";

/**
 * Writers often produce a good strategy in a slightly different shape than the Brain requires
 * ("### Pillar 1: Recipes (40%)", bold section names, weights that add up to 90). This repairs
 * the format only. It never invents pillars; a missing non-pillar section can be filled from the
 * answer-based starter strategy, which states only what the creator answered.
 */
const SECTIONS = [
  "Strategic Goal",
  "Target Audience",
  "Content Pillars",
  "Posting Rhythm",
  "Notes",
] as const;
const LABELS = ["Core Message", "What I Share", "Why It Matters"] as const;

function sectionName(line: string) {
  const headingLike = /^\s*#{1,6}\s+\S/.test(line) || /^\s*\*\*[^*]+\*\*\s*:?\s*$/.test(line);
  if (!headingLike) return null;
  const bare = line
    .replace(/^\s*#{1,6}\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/^\s*\d+[.)]\s*/, "")
    .replace(/[\s:]+$/, "")
    .trim()
    .toLowerCase();
  const aliases: Record<string, (typeof SECTIONS)[number]> = {
    goal: "Strategic Goal",
    "strategic goals": "Strategic Goal",
    audience: "Target Audience",
    pillars: "Content Pillars",
    "content pillar": "Content Pillars",
    "posting cadence": "Posting Rhythm",
    cadence: "Posting Rhythm",
    "posting schedule": "Posting Rhythm",
    note: "Notes",
  };
  return SECTIONS.find((section) => section.toLowerCase() === bare) ?? aliases[bare] ?? null;
}

type Block = { title: string | null; lines: string[] };

function splitBlocks(content: string) {
  const blocks: Block[] = [{ title: null, lines: [] }];
  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    const name = sectionName(line);
    if (name) {
      blocks.push({ title: name, lines: [] });
      continue;
    }
    if (/^##\s+\S/.test(line) && !/^###/.test(line)) {
      blocks.push({ title: line.replace(/^##\s+/, "").trim(), lines: [] });
      continue;
    }
    blocks.at(-1)!.lines.push(line);
  }
  return blocks;
}

function normalizePillars(lines: string[]) {
  const out: string[] = [];
  const pillars: { index: number; weight: number | null; name: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading =
      /^\s*#{3,6}\s+\S/.test(line) ||
      (/^\s*\*\*[^*]+\*\*\s*:?\s*$/.test(line) &&
        !LABELS.some((label) => line.toLowerCase().includes(label.toLowerCase())));
    if (!heading) {
      const weightLine = line.match(/^\s*[-*]?\s*\**\s*weight\s*\**\s*:?\s*\**\s*(\d{1,3})\s*%/i);
      if (weightLine && pillars.length && pillars.at(-1)!.weight === null) {
        pillars.at(-1)!.weight = Number(weightLine[1]);
        continue;
      }
      out.push(line);
      continue;
    }
    const text = line
      .replace(/^\s*#{3,6}\s*/, "")
      .replace(/\*\*/g, "")
      .trim();
    const percent = text.match(/(\d{1,3})\s*%/);
    const name = text
      .replace(/\(?\s*\d{1,3}\s*%\s*\)?/, " ")
      .replace(/^\s*pillar\s*\d*\s*[:.)-]?\s*/i, "")
      .replace(/^\s*\d+[.)]\s*/, "")
      .replace(/^[\s:|,-]+|[\s:|,-]+$/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    pillars.push({
      index: out.length,
      weight: percent ? Number(percent[1]) : null,
      name: name || "Pillar",
    });
    out.push("");
  }
  if (pillars.length >= 2) {
    let weights = pillars.map((pillar) => pillar.weight);
    if (weights.every((weight) => weight === null)) weights = pillars.map(() => 1);
    if (weights.every((weight) => weight !== null && weight > 0)) {
      const raw = weights as number[];
      const sum = raw.reduce((total, weight) => total + weight, 0);
      const scaled = raw.map((weight) => Math.max(1, Math.round((weight * 100) / sum)));
      scaled[scaled.length - 1] += 100 - scaled.reduce((total, weight) => total + weight, 0);
      if (scaled.at(-1)! > 0) pillars.forEach((pillar, index) => (pillar.weight = scaled[index]));
    }
  }
  for (const pillar of pillars)
    out[pillar.index] =
      pillar.weight === null ? `### ${pillar.name}` : `### ${pillar.weight}% ${pillar.name}`;
  return out;
}

function normalizeLabels(line: string) {
  for (const label of LABELS) {
    const pattern = new RegExp(
      `^(\\s*(?:[-*]\\s+)?)\\**\\s*${label.replace(/ /g, "\\s+")}\\s*\\**\\s*:\\s*\\**\\s*`,
      "i",
    );
    if (pattern.test(line)) return line.replace(pattern, `$1${label}: `);
  }
  return line;
}

export function normalizeStrategyContent(content: string, fallback?: string) {
  const blocks = splitBlocks(content);
  const fallbackBlocks = fallback ? splitBlocks(fallback) : [];
  const preamble = blocks[0].lines.join("\n").trim();
  const byTitle = new Map<string, Block>();
  const extrasAfter = new Map<string | null, Block[]>();
  let previous: string | null = null;
  for (const block of blocks.slice(1)) {
    if (block.title && (SECTIONS as readonly string[]).includes(block.title)) {
      const existing = byTitle.get(block.title);
      if (existing) existing.lines.push("", ...block.lines);
      else byTitle.set(block.title, { ...block, lines: [...block.lines] });
      previous = block.title;
    } else {
      extrasAfter.set(previous, [...(extrasAfter.get(previous) ?? []), block]);
    }
  }
  const parts: string[] = [];
  if (preamble) parts.push(preamble);
  for (const extra of extrasAfter.get(null) ?? [])
    parts.push(`## ${extra.title}\n${extra.lines.join("\n").trim()}`);
  for (const section of SECTIONS) {
    let block = byTitle.get(section);
    if (!block || !block.lines.join("").trim()) {
      const replacement =
        section === "Content Pillars"
          ? undefined
          : fallbackBlocks.find((item) => item.title === section);
      if (replacement) block = replacement;
    }
    if (block) {
      let lines = block.lines.map(normalizeLabels);
      if (section === "Content Pillars") lines = normalizePillars(lines);
      parts.push(`## ${section}\n${lines.join("\n").trim()}`);
    }
    for (const extra of extrasAfter.get(section) ?? [])
      parts.push(`## ${extra.title}\n${extra.lines.join("\n").trim()}`);
  }
  return parts
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The repaired strategy when it is complete, otherwise null with a content-free reason. */
export function repairStrategy(content: string, fallback?: string) {
  if (completeContentStrategy(content)) return { content, issue: null };
  const repaired = normalizeStrategyContent(content, fallback);
  if (completeContentStrategy(repaired)) return { content: repaired, issue: null };
  return { content: null, issue: strategyIssue(repaired) };
}

export function strategyIssue(content: string) {
  const missing = SECTIONS.filter(
    (section) => !new RegExp(`^#{1,3} ${section}\\s*$`, "mi").test(content),
  );
  if (missing.length) return `missing sections: ${missing.join(", ")}`;
  const pillars = [...content.matchAll(/^###\s+(\d{1,3})%\s+.+$/gm)];
  if (pillars.length < 2) return "fewer than two weighted pillars";
  const sum = pillars.reduce((total, match) => total + Number(match[1]), 0);
  if (sum !== 100) return `pillar weights total ${sum}`;
  return "pillar labels missing";
}
