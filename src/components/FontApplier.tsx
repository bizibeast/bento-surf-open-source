import { useEffect } from "react";
import { googleFontHref, isGoogleFont } from "@/lib/google-fonts";

function ensureFontLink(family: string) {
  if (!family || !isGoogleFont(family)) return;
  const id = `gf-${family.replace(/\s+/g, "-")}`;
  const href = googleFontHref(family);
  const existing = document.getElementById(id);
  if (existing instanceof HTMLLinkElement) {
    // Repair links created by older builds that requested unsupported font
    // weights. This also makes the fix take effect in an already-open editor.
    if (existing.href !== href) existing.href = href;
    return;
  }
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

/**
 * Loads a profile's typography and exposes it to creator-owned surfaces.
 *
 * - headline => headings, card titles, page titles, and the profile name
 * - body     => body copy, controls, labels, usernames, and descriptions
 *
 * Public creator pages opt into the global tokens. The authenticated app only
 * exposes the user-specific aliases so Bento-owned UI stays on the Bento font
 * system while its creator preview can opt in locally.
 */
export function FontApplier({
  headline,
  body,
  applyGlobalTokens = true,
}: {
  headline?: string | null;
  body?: string | null;
  applyGlobalTokens?: boolean;
}) {
  useEffect(() => {
    const root = document.documentElement;
    if (headline && isGoogleFont(headline)) {
      ensureFontLink(headline);
      const headlineStack = `"${headline}", ui-serif, Georgia, serif`;
      root.style.setProperty("--font-user-headline", headlineStack);
      if (applyGlobalTokens) root.style.setProperty("--font-display", headlineStack);
      else root.style.removeProperty("--font-display");
    } else {
      root.style.removeProperty("--font-user-headline");
      root.style.removeProperty("--font-display");
    }
    if (body && isGoogleFont(body)) {
      ensureFontLink(body);
      const bodyStack = `"${body}", ui-sans-serif, system-ui, sans-serif`;
      root.style.setProperty("--font-user-body", bodyStack);
      if (applyGlobalTokens) root.style.setProperty("--font-sans", bodyStack);
      else root.style.removeProperty("--font-sans");
    } else {
      root.style.removeProperty("--font-user-body");
      root.style.removeProperty("--font-sans");
    }

    return () => {
      root.style.removeProperty("--font-user-headline");
      root.style.removeProperty("--font-user-body");
      root.style.removeProperty("--font-display");
      root.style.removeProperty("--font-sans");
    };
  }, [headline, body, applyGlobalTokens]);

  return null;
}
