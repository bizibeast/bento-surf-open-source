import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { PublicAppChrome } from "@/components/PublicAppChrome";
import { configuredPublicOrigin } from "@/lib/application-urls";
import { getInstancePublicConfig } from "@/lib/instance-public-config";

export const Route = createFileRoute("/terms")({
  head: () => {
    const { appName } = getInstancePublicConfig(import.meta.env);
    return {
      meta: [
        { title: `Terms notice | ${appName}` },
        { name: "description", content: `Terms information for this ${appName} instance.` },
      ],
      links: [
        {
          rel: "canonical",
          href: `${configuredPublicOrigin(import.meta.env.VITE_PUBLIC_URL)}/terms`,
        },
      ],
    };
  },
  component: TermsNotice,
});

function TermsNotice() {
  const { appName, supportEmail, termsUrl } = getInstancePublicConfig(import.meta.env);
  return (
    <PublicAppChrome>
      <main className="min-h-screen bg-[#dfeaff] px-5 py-8 text-[#17213a] sm:px-8 sm:py-12">
        <div className="mx-auto max-w-4xl">
          <header className="rounded-[36px] border border-white/80 bg-white/90 p-7 shadow-[0_28px_80px_-45px_rgba(23,33,58,0.45)] sm:p-12">
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-[#3478f6]">Legal</p>
            <h1 className="mt-4 font-display text-4xl leading-[0.95] sm:text-6xl">
              Terms for this instance.
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-[#17213a]/65 sm:text-lg">
              The instance operator controls access to this {appName} deployment. This page is a
              neutral self-hosting notice, not terms supplied by the software project.
            </p>
          </header>

          <div className="mt-5 grid gap-5 md:grid-cols-2">
            <NoticeSection title="Operator responsibility">
              The instance operator must publish terms appropriate for its deployment, enabled
              features, commercial model, users, and applicable law.
              {termsUrl && (
                <>
                  {" "}
                  <a className="underline" href={termsUrl}>
                    Read the operator&apos;s terms.
                  </a>
                </>
              )}
            </NoticeSection>
            <NoticeSection title="Your responsibility">
              Follow the operator&apos;s terms and applicable laws. You remain responsible for
              content, products, messages, automations, and accounts you connect or make available
              through this instance.
            </NoticeSection>
            <NoticeSection title="Connected services">
              Third-party services have their own terms and availability. The instance operator
              decides which providers are configured and how they are offered.
            </NoticeSection>
            <NoticeSection title="Contact">
              {supportEmail ? (
                <>
                  Contact the instance operator at{" "}
                  <a className="underline" href={`mailto:${supportEmail}`}>
                    {supportEmail}
                  </a>
                  .
                </>
              ) : (
                "The instance operator has not configured a public support address."
              )}
            </NoticeSection>
          </div>
        </div>
      </main>
    </PublicAppChrome>
  );
}

function NoticeSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-[30px] border border-white/80 bg-white/85 p-7 shadow-[0_22px_60px_-42px_rgba(23,33,58,0.42)]">
      <h2 className="font-display text-2xl">{title}</h2>
      <p className="mt-4 text-sm leading-6 text-[#17213a]/68">{children}</p>
    </section>
  );
}
