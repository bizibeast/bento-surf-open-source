import { z } from "zod";

export const productWebsiteSchema = z.object({
  brand: z.string().trim().max(80).default(""),
  accent: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .default("#3478f6"),
  background: z.enum(["paper", "white", "blue"]).default("paper"),
  layout: z.enum(["split", "centered"]).default("split"),
  font: z.enum(["sans", "serif"]).default("sans"),
  sections: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        title: z.string().trim().max(120),
        body: z.string().trim().max(5000),
        imageUrl: z
          .string()
          .max(2048)
          .refine((value) => !value || /^https:\/\//i.test(value), "Use an HTTPS image URL")
          .default(""),
      }),
    )
    .max(12)
    .default([]),
});
export type ProductWebsite = z.infer<typeof productWebsiteSchema>;
export function productWebsite(value: unknown): ProductWebsite {
  const result = productWebsiteSchema.safeParse(value ?? {});
  return result.success ? result.data : productWebsiteSchema.parse({});
}

export function downloadBenefit(name: string, index: number) {
  const extension = name.split(".").at(-1)?.toLowerCase();
  const kind =
    extension === "pdf"
      ? "PDF guide"
      : ["png", "jpg", "jpeg", "webp", "svg"].includes(extension || "")
        ? "Image download"
        : ["mp4", "mov", "webm"].includes(extension || "")
          ? "Video download"
          : ["mp3", "wav", "m4a"].includes(extension || "")
            ? "Audio download"
            : "Downloadable resource";
  return `${kind} ${index + 1}`;
}

export const STORE_TEMPLATE_DRAFTS: Record<
  string,
  { title: string; subtitle: string; description: string }
> = {
  digital_product: {
    title: "My digital download",
    subtitle: "A practical resource your buyer can use right away.",
    description:
      "Explain what is included, who it is for, and the result this download helps the buyer achieve.",
  },
  course: {
    title: "My mini course",
    subtitle: "A clear path from idea to outcome.",
    description:
      "Outline what students will learn, how the lessons are delivered, and the result they can expect.",
  },
  webinar: {
    title: "My live workshop",
    subtitle: "Learn with me in a focused live session.",
    description:
      "Share the topic, who should attend, the agenda, and what participants will leave with.",
  },
  paid_community: {
    title: "My community",
    subtitle: "A focused space to learn and grow together.",
    description:
      "Explain who the community is for, what members receive, and how often you will show up.",
  },
  membership: {
    title: "My membership",
    subtitle: "Ongoing access to resources and support.",
    description:
      "Describe the recurring benefits, new content cadence, and what members can expect each month.",
  },
  priority_dm: {
    title: "Priority message",
    subtitle: "Send me a paid message and move to the front of my inbox.",
    description:
      "Share what you need help with and I will reply within the promised response time.",
  },
  bundle: {
    title: "Creator bundle",
    subtitle: "Get several of my best products in one purchase.",
    description: "A curated collection of downloads, courses, and resources sold together.",
  },
};

export function productAccentTextColor(accent: string) {
  const channels = [1, 3, 5]
    .map((offset) => parseInt(accent.slice(offset, offset + 2), 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return luminance > 0.35 ? "#000000" : "#ffffff";
}
