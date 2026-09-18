import type { ReactNode } from "react";
import { FontApplier } from "@/components/FontApplier";
import { DecodedImage } from "@/components/DecodedImage";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { PageTabs } from "@/components/PageTabs";
import { PatternBackdrop } from "@/components/patterns/PatternBackdrop";
import {
  ACCENT_PALETTE,
  DEFAULT_SETTINGS,
  type PatternId,
  type PatternSettings,
} from "@/lib/patterns/registry";
import { safeMediaUrl, safeNavigationHref } from "@/lib/safe-url";
import { publicProfilePath } from "@/lib/application-urls";
import { BentoIcon } from "@/components/BentoBrand";
import type { PublicCreatorChrome } from "@/lib/public-creator-chrome.server";

export function PublicCreatorShell({
  chrome,
  activePageId,
  children,
}: {
  chrome: PublicCreatorChrome;
  activePageId: string | null;
  children: ReactNode;
}) {
  const { creator: profile, customDomain } = chrome;
  const headerMode: "with_photo" | "no_banner" =
    (profile.header_mode as "with_photo" | "no_banner") ?? "with_photo";
  const themeMode: "light" | "dark" = profile.theme === "dark" ? "dark" : "light";
  const patternId: PatternId = (profile.pattern as PatternId) ?? "none";
  const patternSettings: PatternSettings = {
    ...DEFAULT_SETTINGS,
    ...(profile.pattern_settings &&
    typeof profile.pattern_settings === "object" &&
    !Array.isArray(profile.pattern_settings)
      ? (profile.pattern_settings as Partial<PatternSettings>)
      : {}),
  };
  const accentId = profile.accent_color ?? "indigo";
  const accentHex =
    ACCENT_PALETTE.find((a) => a.id === accentId)?.hex ??
    (typeof accentId === "string" && /^#[0-9a-f]{6}$/i.test(accentId) ? accentId : "#6366f1");

  const showPhoto = headerMode === "with_photo";

  const accentVars =
    themeMode === "dark"
      ? {
          "--background": `color-mix(in oklab, ${accentHex} 14%, #0b0b14)`,
          "--foreground": `color-mix(in oklab, ${accentHex} 35%, #ffffff)`,
          "--card": `color-mix(in oklab, ${accentHex} 10%, #11111b)`,
          "--muted": `color-mix(in oklab, ${accentHex} 18%, #1a1a22)`,
          "--muted-foreground": `color-mix(in oklab, ${accentHex} 40%, #ffffff)`,
          "--accent": `color-mix(in oklab, ${accentHex} 28%, #1f1f29)`,
          "--accent-foreground": `color-mix(in oklab, ${accentHex} 60%, #ffffff)`,
          "--primary": accentHex,
          "--primary-foreground": `color-mix(in oklab, ${accentHex} 0%, #ffffff)`,
          "--ring": accentHex,
          "--border": `color-mix(in oklab, ${accentHex} 22%, #1f1f29)`,
        }
      : {
          "--background": `color-mix(in oklab, ${accentHex} 8%, #ffffff)`,
          "--foreground": `color-mix(in oklab, ${accentHex} 75%, #000000)`,
          "--card": `color-mix(in oklab, ${accentHex} 4%, #ffffff)`,
          "--muted": `color-mix(in oklab, ${accentHex} 14%, #ffffff)`,
          "--muted-foreground": `color-mix(in oklab, ${accentHex} 55%, #000000)`,
          "--accent": `color-mix(in oklab, ${accentHex} 18%, #ffffff)`,
          "--accent-foreground": `color-mix(in oklab, ${accentHex} 70%, #000000)`,
          "--primary": accentHex,
          "--primary-foreground": `color-mix(in oklab, ${accentHex} 0%, #ffffff)`,
          "--ring": accentHex,
          "--border": `color-mix(in oklab, ${accentHex} 20%, #ffffff)`,
        };

  const initial = (profile.display_name || profile.username || "?")[0]?.toUpperCase();
  const NameHeading = activePageId ? "p" : "h1";

  return (
    <div
      data-bento-public-page="true"
      data-theme={themeMode}
      style={accentVars as React.CSSProperties}
      className={`relative isolate ${themeMode === "dark" ? "dark" : ""} min-h-screen w-full text-foreground`}
    >
      <div
        className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
        style={{ background: "var(--background)" }}
      >
        <PatternBackdrop
          pattern={patternId}
          settings={patternSettings}
          accentHex={accentHex}
          theme={themeMode}
        />
      </div>
      <FontApplier headline={profile.secondary_font} body={profile.primary_font} />
      <div className="mx-auto w-full max-w-6xl px-3 pt-8 lg:px-6 lg:pt-0 lg:pb-0 lg:min-h-[calc(100vh-4rem)]">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[380px_1fr] lg:gap-11 lg:overflow-visible">
          <aside className="flex w-full flex-col items-center text-center text-foreground lg:sticky lg:top-0 lg:self-start lg:items-start lg:text-left lg:overflow-visible lg:min-h-[calc(100vh-4rem)] lg:py-8 lg:pl-1 lg:pr-2">
            {showPhoto &&
              (safeMediaUrl(profile.avatar_url) ? (
                <DecodedImage
                  src={safeMediaUrl(profile.avatar_url)!}
                  alt={`${profile.display_name || profile.username} avatar`}
                  width={640}
                  height={640}
                  loading="eager"
                  fetchPriority="high"
                  className="size-32 rounded-full object-cover ring-1 ring-border lg:size-40"
                />
              ) : (
                <div className="flex size-32 items-center justify-center rounded-full bg-foreground font-display text-5xl text-background lg:size-40">
                  {initial}
                </div>
              ))}
            <NameHeading
              className="mt-4 font-display text-2xl text-foreground"
              style={{ fontFamily: "var(--font-user-headline, var(--font-display))" }}
            >
              <span className="inline-flex items-center gap-1.5">
                {profile.display_name || profile.username}
                <VerifiedBadge className="size-[1.1em]" active={Boolean(profile.is_pro)} />
              </span>
            </NameHeading>
            {profile.username && (
              <span
                className="text-sm text-muted-foreground"
                style={{ fontFamily: "var(--font-user-body, inherit)" }}
              >
                @{profile.username}
              </span>
            )}
            {customDomain && <span className="text-sm text-muted-foreground">{customDomain}</span>}
            {profile.bio && (
              <p
                className="mt-3 max-w-[16rem] text-sm leading-relaxed text-muted-foreground"
                style={{ fontFamily: "var(--font-user-body, inherit)" }}
              >
                {profile.bio}
              </p>
            )}
            <nav aria-label="Creator pages" className="mt-4 w-full lg:flex lg:justify-start">
              <PageTabs
                pages={chrome.pages}
                activeId={activePageId}
                homeHref={customDomain ? "/" : publicProfilePath(profile.username)}
                mode="public"
                onSelect={() => {}}
              />
            </nav>
            {!profile.badge_hidden && (
              <a
                href={
                  customDomain
                    ? safeNavigationHref(import.meta.env.VITE_PUBLIC_URL) || "http://localhost:8080"
                    : "/"
                }
                className="mt-6 inline-flex items-center gap-1 self-center rounded-lg border border-border bg-card px-2.5 py-1 text-[10px] text-muted-foreground hover:bg-accent lg:mt-auto lg:self-start"
              >
                Made with <BentoIcon className="ml-0.5 size-3" />
                <span className="font-semibold text-foreground">bento.surf</span>
              </a>
            )}
          </aside>

          <main className="lg:pb-32 lg:pt-8">{children}</main>
        </div>
      </div>
    </div>
  );
}
