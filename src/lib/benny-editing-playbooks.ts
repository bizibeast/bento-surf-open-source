import type { BrainItem, BrainItemInput } from "./content-brain";

export type BennyEditingPlaybook = {
  id: string;
  title: string;
  kind: "reel" | "carousel";
  description: string;
  instructions: string;
};

// Adapted from the creator-owned BiziBeast content engine. Personal assets,
// accounts, branding and provider IDs are deliberately not bundled.
export const BENNY_EDITING_PLAYBOOKS: readonly BennyEditingPlaybook[] = [
  {
    id: "doodle",
    title: "Doodle",
    kind: "reel",
    description: "An illustrated presenter, paper-like scenes and purposeful drawn motion.",
    instructions:
      "Use my saved brand, language and authorized illustrated character. Build paper-like scenes with restrained line drawings and one accent. Match each visual to the spoken idea, use a calm conversational voice, and time character mouth movements to the narration when supported. Introduce the outcome immediately, vary a visual every few seconds, and keep captions readable. Keep faces and important text inside platform safe zones. Use subtle sound and a clear final CTA. Never substitute another person's likeness or invent metrics. This playbook guides scene planning; use only available assets and supported rendering capabilities.",
  },
  {
    id: "split-screen",
    title: "Split screen",
    kind: "reel",
    description: "Explanations and source footage above a clearly visible presenter.",
    instructions:
      "Use my saved brand and authorized presenter footage. Plan varied explanatory graphics, screenshots or credited source footage above the presenter, who fills the lower panel without blurred side fill. Change layout or motion when the spoken idea changes. Keep titles below platform chrome, preserve the whole face, and place captions where they cover neither the presenter nor important source details. Start with the concrete outcome and end with a useful CTA. Generate avatar footage only while the avatar is visible; retain continuous narration over non-avatar scenes. Never assume permission to reuse source media or publish.",
  },
  {
    id: "studio-presenter",
    title: "Studio presenter",
    kind: "reel",
    description: "A cut-out presenter with layered panels, soft glows and animated titles.",
    instructions:
      "Use my saved brand and authorized presenter assets. Plan a cut-out presenter in front of a studio panel, alternating with clean explanatory cards and occasional full-presenter scenes. Give titles a short blur-in and rise, use restrained glows and smooth transitions, and keep the presenter separate from background graphics. Reserve clear space for captions and avoid covering the face. Match visual beats to narration, keep audio continuous and reuse assets for scene edits. Only request visible avatar segments and supported cut-out processing. Finish with a readable cover and CTA; do not invent assets, claims or publication approval.",
  },
  {
    id: "cartoon-presenter",
    title: "Cartoon presenter",
    kind: "reel",
    description: "A personal cartoon character presenting expressive cards and UI scenes.",
    instructions:
      "Use my saved brand and my authorized cartoon character as the presenter. Build expressive cards and UI-inspired scenes, with occasional world or cinematic scenes when they clarify the story. Keep headlines away from the character's head, use a small consistent pose set, and synchronize simple mouth movement to narration when supported. A secondary mascot is optional and must be supplied or approved. Keep motion smooth, captions readable and the layout inside platform safe zones. Begin with a concrete hook, explain one idea per beat and end with a clear CTA. Use available assets and editable scene structures rather than claiming unavailable animation capabilities.",
  },
  {
    id: "premium-editorial",
    title: "Premium editorial",
    kind: "carousel",
    description: "An airy editorial carousel with strong hierarchy and one idea per slide.",
    instructions:
      "Use my saved brand, fonts, logo and authorized portraits. Create an airy editorial carousel, typically 7–10 slides, with a concrete number-and-outcome hook when the number is supported. Use a strong two-line headline, one accent word, generous whitespace and a clear supporting visual. Middle slides explain one original idea each with short copy, an index and a purposeful card, diagram or owned image. Use verified brand logos only when relevant and available. Add a differentiated insight and a final CTA. Keep all essential content within platform crop-safe margins. Never invent results, repeat slide ideas or flatten editable slide structures unnecessarily.",
  },
];

export function savedEditingPlaybook(playbook: BennyEditingPlaybook, items: readonly BrainItem[]) {
  return items.find(
    (item) =>
      item.provenance === "creator" &&
      item.status === "confirmed" &&
      item.tags?.includes("playbook:" + playbook.id) &&
      item.tags.includes(playbook.kind),
  );
}

export function editingPlaybookMemory(playbook: BennyEditingPlaybook): BrainItemInput {
  return {
    kind: "instruction",
    title: playbook.title,
    content: playbook.instructions,
    provenance: "creator",
    status: "confirmed",
    locked: false,
    tags: ["creative-preference", playbook.kind, "editing-playbook", "playbook:" + playbook.id],
    sourceRef: "benny:editing-playbook:v1:" + playbook.id,
  };
}

export function creativePreferenceContext(items: readonly unknown[], format?: "reel" | "carousel") {
  const result: Array<{ title: string; content: string; kind: string | null }> = [];
  const updatedAt = (item: unknown) => {
    if (!item || typeof item !== "object") return 0;
    const value = (item as Record<string, unknown>).updatedAt;
    const time = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(time) ? time : 0;
  };
  // A recently corrected instruction must not disappear behind four older playbooks.
  for (const item of [...items].sort((a, b) => updatedAt(b) - updatedAt(a))) {
    if (result.length >= 4) break;
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const tags = Array.isArray(row.tags)
      ? row.tags.filter((tag): tag is string => typeof tag === "string")
      : [];
    if (
      row.provenance !== "creator" ||
      row.status !== "confirmed" ||
      !tags.includes("creative-preference") ||
      typeof row.title !== "string" ||
      typeof row.content !== "string"
    )
      continue;
    const kind = tags.find((tag) => ["carousel", "reel", "avatar"].includes(tag)) ?? null;
    if (format && kind && kind !== format && !(format === "reel" && kind === "avatar")) continue;
    result.push({
      title: row.title.slice(0, 160),
      content: row.content.slice(0, 1000),
      kind,
    });
  }
  return result;
}
