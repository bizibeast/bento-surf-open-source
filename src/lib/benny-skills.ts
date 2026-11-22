import { LINKEDIN_OS_INSTRUCTIONS } from "./benny-linkedin-os";
import type { BrainItem, BrainItemInput } from "./content-brain";

const common =
  "Read the creator's confirmed Brain preferences first. Use real stored evidence and exact IDs from tools. Cite sources and dates, distinguish missing data from zero, and never invent facts or completed actions. Prepare externally visible changes for approval. Provider calls require the correct user-funded connection or managed allowance.";
const definitions = [
  [
    "trend-discovery",
    "Trend discovery",
    ["get_content_discover", "read_workspace_data"],
    "Identify emerging niche topics from dated Discover evidence. Separate fresh research from cached signals; request authorized research when evidence is stale.",
  ],
  [
    "competitor-research",
    "Competitor research",
    ["get_content_discover", "read_workspace_data"],
    "Compare available competitor posts, formats, hooks and engagement. Report the sample size and observation dates; do not infer private analytics.",
  ],
  [
    "viral-analysis",
    "Viral content analysis",
    ["get_analytics_workspace", "get_content_discover"],
    "Compare like-for-like posts against the creator's baseline. Explain the observed hook, format and distribution, without claiming causation from one post.",
  ],
  [
    "hooks",
    "Hook generation",
    ["get_content_brain", "get_content_discover"],
    "Generate distinct, specific hooks in the creator's voice. Avoid unsupported numbers, invented outcomes and misleading urgency.",
  ],
  [
    "scripts",
    "Scriptwriting",
    ["get_content_brain", "read_workspace_data"],
    "Write a concrete hook, useful beats and a clear CTA. Separate narration, on-screen copy, scene assets and source-backed factual claims.",
  ],
  [
    "content-planning",
    "Content planning",
    ["get_content_routines", "get_scheduler_workspace", "get_analytics_workspace"],
    "Build a realistic plan around connected accounts, existing scheduled posts and the creator's goals. Preserve occupied slots and review requirements.",
  ],
  [
    "carousels",
    "Carousel creation",
    ["get_content_brain", "get_content_media"],
    "Create editable slide-by-slide copy with one useful idea per slide, brand presets, owned assets, a supported hook and a final CTA.",
  ],
  [
    "reels",
    "Reel planning",
    ["get_content_media", "list_social_accounts"],
    "Plan scenes, timing, narration, caption cues, B-roll and music. Generate avatar footage only for visible avatar scenes. Use the available renderer and funding mode; never claim a script is a finished MP4.",
  ],
  [
    "captions",
    "Caption generation",
    ["get_content_brain", "list_social_accounts"],
    "Write platform-specific captions with the requested CTA and supplied handles. Respect connected account limits and avoid inventing video details.",
  ],
  [
    "repurposing",
    "Platform repurposing",
    ["get_social_post", "get_content_media", "create_social_post"],
    "Read the original content, adapt its hook and format for each destination, and prepare one multi-platform draft with per-account captions. Preserve the original claims.",
  ],
  [
    "growth",
    "Creator growth analysis",
    ["get_analytics_workspace", "get_content_routines"],
    "Summarize dated follower, engagement and publishing evidence. Recommend measurable experiments and follow-ups, showing uncertainty and missing metrics.",
  ],
  [
    "store",
    "Store optimization",
    ["get_store_workspace", "get_analytics_workspace", "manage_product"],
    "Inspect the actual offers, pages and sales evidence. Recommend specific improvements and prepare only requested changes for review; never invent prices or sales.",
  ],
  [
    "dm-automation",
    "DM automation",
    ["list_social_accounts", "list_auto_dm_automations", "save_auto_dm_automation"],
    "Inspect account readiness and existing automations. Prepare a keyword workflow with the exact reply and link, respect provider messaging restrictions, and obtain approval before enabling messages.",
  ],
  [
    "linkedin-os",
    "LinkedIn strategy and writing",
    [
      "get_content_brain",
      "read_workspace_data",
      "get_content_discover",
      "get_analytics_workspace",
      "get_scheduler_workspace",
      "get_content_media",
      "list_social_accounts",
      "list_social_posts",
      "create_social_post",
    ],
    LINKEDIN_OS_INSTRUCTIONS,
  ],
] as const;

export const BENNY_SKILLS = definitions.map(([id, title, tools, instruction]) => ({
  id,
  title,
  tools: [...tools],
  uri: `skill://bento/benny/${id}/SKILL.md`,
  instructions: `# ${title}\n\n${common}\n\n${instruction}\n\n## Tools\n\n${tools.map((tool) => `- ${tool}`).join("\n")}`,
}));
export const bennySkillReference = (id: string) => `benny:skill:${id}`;
export function savedBennySkill(items: BrainItem[], id: string) {
  return items.find(
    (item) =>
      item.sourceRef === bennySkillReference(id) &&
      item.provenance === "creator" &&
      item.status === "confirmed",
  );
}
export function bennySkillInput(
  skill: (typeof BENNY_SKILLS)[number],
  content: string,
  prior?: BrainItem,
): BrainItemInput {
  return {
    ...(prior ? { id: prior.id } : {}),
    kind: "instruction",
    title: skill.title,
    content: content.trim() || `# ${skill.title}`,
    sourceRef: bennySkillReference(skill.id),
    provenance: "creator",
    status: "confirmed",
    locked: true,
    tags: ["skill"],
  };
}
