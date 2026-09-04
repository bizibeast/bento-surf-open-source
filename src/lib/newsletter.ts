import { z } from "zod";
import { DEFAULT_PUBLIC_ORIGIN } from "./application-urls";
import { parsePublicHttpUrl } from "./safe-url";

export type NewsletterBlockVisibility = "both" | "email" | "web";

export type NewsletterBlockStyle = {
  backgroundColor?: string;
  color?: string;
  padding?: number;
  textAlign?: "left" | "center" | "right";
  borderRadius?: number;
  borderColor?: string;
  borderWidth?: number;
  fontSize?: number;
  fontWeight?: 400 | 500 | 600 | 700 | 800;
};

type NewsletterBlockBase = {
  id: string;
  visibility?: NewsletterBlockVisibility;
  style?: NewsletterBlockStyle;
};

export type NewsletterLeafBlock = NewsletterBlockBase &
  (
    | { type: "paragraph" | "heading"; text: string }
    | { type: "image"; url: string; alt: string; caption?: string; href?: string }
    | { type: "button"; label: string; url: string; variant?: "solid" | "outline" | "link" }
    | { type: "divider" }
    | { type: "product"; productId: string }
    | { type: "social"; label: string; url: string }
    | { type: "quote"; text: string; attribution?: string }
    | { type: "list"; items: string[]; ordered?: boolean }
    | { type: "spacer"; height: number }
  );

export type NewsletterContentBlock =
  | NewsletterLeafBlock
  | (NewsletterBlockBase & {
      type: "section";
      layout: "two-equal" | "two-left" | "two-right";
      columns: [NewsletterLeafBlock[], NewsletterLeafBlock[]];
    });

const id = z.string().trim().min(1).max(100);
const hexColor = z.string().regex(/^#[0-9a-f]{6}$/i, "Use a six-digit hex color.");
const safeLink = z
  .string()
  .trim()
  .max(2_048)
  .refine(
    (value) =>
      (value.startsWith("/") && !value.startsWith("//")) ||
      (() => {
        try {
          return new URL(value).protocol === "https:";
        } catch {
          return false;
        }
      })(),
    "Use an HTTPS URL or same-origin path.",
  );

const blockStyleSchema = z
  .object({
    backgroundColor: hexColor.optional(),
    color: hexColor.optional(),
    padding: z.number().int().min(0).max(80).optional(),
    textAlign: z.enum(["left", "center", "right"]).optional(),
    borderRadius: z.number().int().min(0).max(48).optional(),
    borderColor: hexColor.optional(),
    borderWidth: z.number().int().min(0).max(8).optional(),
    fontSize: z.number().int().min(10).max(72).optional(),
    fontWeight: z
      .union([z.literal(400), z.literal(500), z.literal(600), z.literal(700), z.literal(800)])
      .optional(),
  })
  .strict();

const baseShape = {
  id,
  visibility: z.enum(["both", "email", "web"]).optional(),
  style: blockStyleSchema.optional(),
};

const newsletterLeafBlockSchema = z.discriminatedUnion("type", [
  z
    .object({ ...baseShape, type: z.enum(["paragraph", "heading"]), text: z.string().max(20_000) })
    .strict(),
  z
    .object({
      ...baseShape,
      type: z.literal("image"),
      url: safeLink,
      alt: z.string().max(500),
      caption: z.string().max(500).optional(),
      href: safeLink.optional(),
    })
    .strict(),
  z
    .object({
      ...baseShape,
      type: z.literal("button"),
      label: z.string().trim().min(1).max(120),
      url: safeLink,
      variant: z.enum(["solid", "outline", "link"]).optional(),
    })
    .strict(),
  z.object({ ...baseShape, type: z.literal("divider") }).strict(),
  z.object({ ...baseShape, type: z.literal("product"), productId: z.string().uuid() }).strict(),
  z
    .object({
      ...baseShape,
      type: z.literal("social"),
      label: z.string().trim().min(1).max(120),
      url: safeLink,
    })
    .strict(),
  z
    .object({
      ...baseShape,
      type: z.literal("quote"),
      text: z.string().trim().min(1).max(20_000),
      attribution: z.string().trim().max(200).optional(),
    })
    .strict(),
  z
    .object({
      ...baseShape,
      type: z.literal("list"),
      items: z.array(z.string().trim().min(1).max(2_000)).min(1).max(30),
      ordered: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      ...baseShape,
      type: z.literal("spacer"),
      height: z.number().int().min(8).max(160),
    })
    .strict(),
]);

const newsletterSectionSchema = z
  .object({
    ...baseShape,
    type: z.literal("section"),
    layout: z.enum(["two-equal", "two-left", "two-right"]),
    columns: z.tuple([
      z.array(newsletterLeafBlockSchema).max(30),
      z.array(newsletterLeafBlockSchema).max(30),
    ]),
  })
  .strict();

const newsletterContentBlockSchema = z.union([newsletterLeafBlockSchema, newsletterSectionSchema]);

function allBlockIds(content: NewsletterContentBlock[]) {
  return content.flatMap((block) =>
    block.type === "section"
      ? [block.id, ...block.columns.flat().map((child) => child.id)]
      : [block.id],
  );
}

export const newsletterContentSchema = z
  .array(newsletterContentBlockSchema)
  .max(100)
  .superRefine((content, context) => {
    const ids = allBlockIds(content);
    if (ids.length > 100) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Newsletter content cannot contain more than 100 blocks.",
      });
    }
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Newsletter block IDs must be unique.",
      });
    }
    if (JSON.stringify(content).length > 100_000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Newsletter content is too large.",
      });
    }
  });

function blockPlainText(block: NewsletterContentBlock): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return block.text;
    case "image":
      return block.alt ? `[Image: ${block.alt}]` : "";
    case "button":
    case "social":
      return `${block.label}: ${block.url}`;
    case "divider":
      return "---";
    case "product":
      return `Product: ${block.productId}`;
    case "quote":
      return `“${block.text}”${block.attribution ? ` - ${block.attribution}` : ""}`;
    case "list":
      return block.items.join("\n");
    case "spacer":
      return "";
    case "section":
      return block.columns.flat().map(blockPlainText).filter(Boolean).join("\n\n");
  }
}

export function newsletterPlainText(content: NewsletterContentBlock[]): string {
  return content.map(blockPlainText).filter(Boolean).join("\n\n");
}

export function moveNewsletterBlock(
  content: NewsletterContentBlock[],
  fromIndex: number,
  toIndex: number,
) {
  if (fromIndex === toIndex || fromIndex < 0 || fromIndex >= content.length) return content;
  const next = [...content];
  const [block] = next.splice(fromIndex, 1);
  next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, block);
  return next;
}

function cloneNewsletterBlock(
  block: NewsletterContentBlock,
  idFactory: () => string,
): NewsletterContentBlock {
  if (block.type !== "section") return { ...block, id: idFactory() } as NewsletterLeafBlock;
  return {
    ...block,
    id: idFactory(),
    columns: block.columns.map((column) =>
      column.map((child) => cloneNewsletterBlock(child, idFactory) as NewsletterLeafBlock),
    ) as [NewsletterLeafBlock[], NewsletterLeafBlock[]],
  };
}

export function duplicateNewsletterBlock(
  content: NewsletterContentBlock[],
  index: number,
  idFactory: () => string = () => crypto.randomUUID(),
) {
  const block = content[index];
  if (!block) return content;
  const next = [...content];
  next.splice(index + 1, 0, cloneNewsletterBlock(block, idFactory));
  return next;
}

export function newsletterPublicSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function safeNewsletterUrl(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    try {
      const relative = new URL(trimmed, DEFAULT_PUBLIC_ORIGIN);
      if (relative.origin === DEFAULT_PUBLIC_ORIGIN) {
        return `${relative.pathname}${relative.search}${relative.hash}`;
      }
    } catch {
      return null;
    }
  }
  return parsePublicHttpUrl(trimmed, { requireHttps: true })?.toString() ?? null;
}
