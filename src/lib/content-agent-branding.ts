import { z } from "zod";

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Choose a six-digit hex color.");
export function contrastRatio(a: string, b: string) {
  const luminance = (hex: string) => {
    const values = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
  };
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function colorOn(background: string) {
  const white = contrastRatio(background, "#ffffff");
  const navy = contrastRatio(background, "#17213a");
  if (navy >= 4.5 && navy > white) return "#17213a";
  return white >= 4.5 ? "#ffffff" : "#000000";
}
export const agentBrandingSchema = z
  .object({
    accentColor: color.default("#31577f"),
    backgroundColor: color.default("#f7f4ed"),
    textColor: color.default("#17213a"),
    coverStyle: z.enum(["text", "portrait"]).default("text"),
    heroPhotoId: z.string().uuid().nullable().default(null),
  })
  .refine((brand) => contrastRatio(brand.backgroundColor, brand.textColor) >= 4.5, {
    message: "Choose text and background colors with stronger contrast (at least 4.5:1).",
  });
export type AgentBranding = z.infer<typeof agentBrandingSchema>;
export const DEFAULT_AGENT_BRANDING = agentBrandingSchema.parse({});
export function agentBranding(value: unknown): AgentBranding {
  const parsed = agentBrandingSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...DEFAULT_AGENT_BRANDING };
}
