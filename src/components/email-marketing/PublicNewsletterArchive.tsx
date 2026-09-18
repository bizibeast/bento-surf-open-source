import { PublicCreatorShell } from "@/components/public/PublicCreatorShell";
import { PublicSystemPageCanvas } from "@/components/public/PublicSystemPageCanvas";
import type { PublicCreatorChrome } from "@/lib/public-creator-chrome.server";
import type { SystemPageItem, SystemItemLayout } from "@/lib/page-system-layout";
import type { CSSProperties, ReactNode } from "react";
import { BlockRenderer, type Block } from "@/components/blocks/BlockRenderer";
import { DecodedImage } from "@/components/DecodedImage";
import { FontApplier } from "@/components/FontApplier";
import { PatternBackdrop } from "@/components/patterns/PatternBackdrop";
import {
  publicNewsletterPostPath,
  publicNewslettersPath,
  publicProductPath,
} from "@/lib/application-urls";
import {
  ACCENT_PALETTE,
  DEFAULT_SETTINGS,
  type PatternId,
  type PatternSettings,
} from "@/lib/patterns/registry";
import { safeMediaUrl } from "@/lib/safe-url";

export type PublicNewsletterCreator = {
  username: string;
  displayName: string;
  avatarUrl?: string | null;
  bio?: string;
  theme?: "light" | "dark";
  accentColor?: string | null;
  primaryFont?: string | null;
  secondaryFont?: string | null;
  pattern?: string | null;
  patternSettings?: Partial<PatternSettings> | null;
};

export type PublicNewsletterArchiveData = {
  chrome?: PublicCreatorChrome;
  activePageId?: string | null;
  creator: PublicNewsletterCreator;
  publication: {
    title: string;
    slug: string;
    description: string;
    postalAddress: string;
    logoUrl?: string | null;
  };
  paidProduct: { title: string; publicSlug: string } | null;
  signupBlock?: Block | null;
  issues: Array<{
    slug: string;
    subject: string;
    previewText: string;
    visibility: "public" | "paid";
  }>;
};

export type PublicNewsletterDirectoryData = {
  chrome: PublicCreatorChrome;
  page: { id: string };
  blocks: Parameters<typeof PublicSystemPageCanvas>[0]["blocks"];
  systemItems: SystemPageItem[];
  systemLayout: SystemItemLayout[];
  creator: PublicNewsletterCreator;
  publications: Array<{
    title: string;
    slug: string;
    description: string;
    logoUrl?: string | null;
    accentColor?: string | null;
  }>;
};

function themeStyle(creator: PublicNewsletterCreator) {
  const dark = creator.theme === "dark";
  const accentId = creator.accentColor ?? "indigo";
  const accentHex =
    ACCENT_PALETTE.find((accent) => accent.id === accentId)?.hex ??
    (/^#[0-9a-f]{6}$/i.test(accentId) ? accentId : "#6366f1");
  return {
    accentHex,
    themeMode: dark ? ("dark" as const) : ("light" as const),
    variables: (dark
      ? {
          "--background": `color-mix(in oklab, ${accentHex} 14%, #0b0b14)`,
          "--foreground": `color-mix(in oklab, ${accentHex} 35%, #ffffff)`,
          "--card": `color-mix(in oklab, ${accentHex} 10%, #11111b)`,
          "--muted": `color-mix(in oklab, ${accentHex} 18%, #1a1a22)`,
          "--muted-foreground": `color-mix(in oklab, ${accentHex} 40%, #ffffff)`,
          "--accent": `color-mix(in oklab, ${accentHex} 28%, #1f1f29)`,
          "--accent-foreground": `color-mix(in oklab, ${accentHex} 60%, #ffffff)`,
          "--primary": accentHex,
          "--primary-foreground": "#ffffff",
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
          "--primary-foreground": "#ffffff",
          "--ring": accentHex,
          "--border": `color-mix(in oklab, ${accentHex} 20%, #ffffff)`,
        }) as CSSProperties,
  };
}

export function PublicNewsletterTheme({
  creator,
  children,
}: {
  creator: PublicNewsletterCreator;
  children: ReactNode;
}) {
  const { accentHex, themeMode, variables } = themeStyle(creator);
  const patternSettings: PatternSettings = {
    ...DEFAULT_SETTINGS,
    ...(creator.patternSettings ?? {}),
  };
  return (
    <main
      data-bento-public-page="true"
      data-theme={themeMode}
      style={{ ...variables, fontFamily: "var(--font-user-body, var(--font-sans))" }}
      className={`relative isolate min-h-screen overflow-hidden text-foreground ${themeMode === "dark" ? "dark" : ""}`}
    >
      <div
        className="pointer-events-none absolute inset-0 -z-10"
        style={{ background: "var(--background)" }}
      >
        <PatternBackdrop
          pattern={(creator.pattern as PatternId) || "none"}
          settings={patternSettings}
          accentHex={accentHex}
          theme={themeMode}
        />
      </div>
      <FontApplier headline={creator.secondaryFont} body={creator.primaryFont} />
      {children}
    </main>
  );
}

function PublicationLogo({
  url,
  title,
  className,
}: {
  url?: string | null;
  title: string;
  className: string;
}) {
  const safeUrl = safeMediaUrl(url);
  return safeUrl ? (
    <DecodedImage src={safeUrl} alt={`${title} logo`} className={className} />
  ) : (
    <div className={`${className} grid place-items-center bg-primary font-semibold text-white`}>
      {title.slice(0, 1).toUpperCase()}
    </div>
  );
}

const headlineStyle = { fontFamily: "var(--font-user-headline, var(--font-display))" };

export function PublicNewsletterDirectoryContent({
  data,
}: {
  data: PublicNewsletterDirectoryData;
}) {
  return (
    <PublicCreatorShell chrome={data.chrome} activePageId={data.page.id}>
      <section aria-label="Publications">
        {data.blocks.length || data.systemItems.length ? (
          <PublicSystemPageCanvas
            username={data.creator.username}
            blocks={data.blocks}
            systemItems={data.systemItems}
            systemLayout={data.systemLayout}
          />
        ) : (
          <div className="rounded-2xl border border-border bg-card p-8 text-sm text-muted-foreground">
            No newsletters yet.
          </div>
        )}
      </section>
    </PublicCreatorShell>
  );
}

export function PublicNewsletterArchiveContent({
  data,
  beforeContent,
  emailCaptureInteractive,
}: {
  data: PublicNewsletterArchiveData;
  beforeContent?: ReactNode;
  emailCaptureInteractive: boolean;
}) {
  const content = (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      {beforeContent}
      <a
        href={publicNewslettersPath(data.creator.username)}
        className="mb-4 inline-flex text-sm font-semibold text-muted-foreground hover:text-foreground"
      >
        ← All newsletters
      </a>
      <header className="rounded-2xl border border-border bg-card p-7 shadow-sm sm:p-10">
        <PublicationLogo
          url={data.publication.logoUrl}
          title={data.publication.title}
          className="mb-5 size-14 rounded-xl object-cover"
        />
        <p className="text-sm text-muted-foreground">{data.creator.displayName}</p>
        <h1 className="mt-2 text-4xl text-foreground" style={headlineStyle}>
          {data.publication.title}
        </h1>
        {data.publication.description ? (
          <p className="mt-4 leading-7 text-muted-foreground">{data.publication.description}</p>
        ) : null}
        {data.paidProduct ? (
          <a
            href={publicProductPath(data.creator.username, data.paidProduct.publicSlug)}
            className="mt-6 inline-flex rounded-lg bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground"
          >
            Subscribe to paid posts
          </a>
        ) : null}
      </header>
      {data.signupBlock ? (
        <section className="mx-auto mt-6 max-w-sm" aria-label="Newsletter signup">
          <BlockRenderer
            block={data.signupBlock}
            emailCaptureInteractive={emailCaptureInteractive}
          />
        </section>
      ) : null}
      <section className="mt-8 space-y-3" aria-label="Newsletter posts">
        {data.issues.length ? (
          data.issues.map((issue) => (
            <a
              key={issue.slug}
              href={publicNewsletterPostPath(
                data.creator.username,
                data.publication.slug,
                issue.slug,
              )}
              className="block rounded-xl border border-border bg-card p-5 shadow-sm transition hover:-translate-y-0.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-xl text-foreground" style={headlineStyle}>
                  {issue.subject}
                </h2>
                {issue.visibility === "paid" ? (
                  <span className="rounded-md bg-primary px-2.5 py-1 text-[10px] font-semibold text-primary-foreground">
                    Paid
                  </span>
                ) : null}
              </div>
              {issue.previewText ? (
                <p className="mt-2 text-sm text-muted-foreground">{issue.previewText}</p>
              ) : null}
            </a>
          ))
        ) : (
          <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
            No public posts yet.
          </p>
        )}
      </section>
      <footer className="mt-10 text-center text-xs text-muted-foreground">
        {data.creator.displayName}
      </footer>
    </div>
  );
  return data.chrome ? (
    <PublicCreatorShell chrome={data.chrome} activePageId={data.activePageId ?? null}>
      {content}
    </PublicCreatorShell>
  ) : (
    <PublicNewsletterTheme creator={data.creator}>{content}</PublicNewsletterTheme>
  );
}
