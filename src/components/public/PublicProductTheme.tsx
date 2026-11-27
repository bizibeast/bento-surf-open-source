import type { ReactNode } from "react";
import { FontApplier } from "@/components/FontApplier";
import { PatternBackdrop } from "@/components/patterns/PatternBackdrop";
import {
  resolvePublicCreatorTheme,
  type PublicCreatorThemeInput,
} from "@/lib/public-creator-theme";

/** Retains product branding/layout while inheriting the creator's live Link design. */
export function PublicProductTheme({
  creator,
  children,
  className = "",
}: {
  creator: PublicCreatorThemeInput;
  children: ReactNode;
  className?: string;
}) {
  const theme = resolvePublicCreatorTheme(creator);
  return (
    <div
      data-product-website
      data-bento-public-page="true"
      data-theme={theme.mode}
      className={`relative isolate min-h-screen w-full text-foreground ${theme.mode === "dark" ? "dark" : ""} ${className}`}
      style={theme.style}
    >
      <div
        className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
        style={{ background: "var(--background)" }}
      >
        <PatternBackdrop
          pattern={theme.pattern}
          settings={theme.patternSettings}
          accentHex={theme.accentHex}
          theme={theme.mode}
        />
      </div>
      <FontApplier headline={creator.secondary_font} body={creator.primary_font} />
      <style>{`[data-product-website] :is(h1,h2,h3,h4,h5,h6) { font-family: var(--font-display); }`}</style>
      {children}
    </div>
  );
}
