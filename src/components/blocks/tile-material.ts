export type Material = "gradient" | "transparent" | "glass" | "fill";

export function tileMaterialStyle(material: Material, accent: string): React.CSSProperties {
  switch (material) {
    case "gradient":
      return {
        background: `linear-gradient(135deg, color-mix(in oklab, ${accent} 30%, white), color-mix(in oklab, ${accent} 75%, black 8%))`,
        color: "#0f172a",
      };
    case "transparent":
      return {
        background: "transparent",
        color: "#0f172a",
        boxShadow: "inset 0 0 0 1px rgba(15,23,42,0.12)",
      };
    case "glass":
      return {
        background: `linear-gradient(135deg, color-mix(in oklab, ${accent} 10%, rgba(255,255,255,0.74)), rgba(255,255,255,0.36)), radial-gradient(circle at 20% 0%, rgba(255,255,255,0.85), transparent 34%)`,
        color: "#0f172a",
        backdropFilter: "blur(22px) saturate(190%) contrast(104%)",
        boxShadow:
          "inset 0 0 0 1px rgba(255,255,255,0.72), inset 0 0 24px rgba(255,255,255,0.34), 0 18px 48px rgba(15,23,42,0.14)",
      };
    case "fill":
      return {
        background: `color-mix(in oklab, ${accent} 20%, white)`,
        color: "#0f172a",
      };
  }
}
