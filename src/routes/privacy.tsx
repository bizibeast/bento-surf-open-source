import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { PublicAppChrome } from "@/components/PublicAppChrome";
import { configuredPublicOrigin } from "@/lib/application-urls";
import { getInstancePublicConfig } from "@/lib/instance-public-config";

export const Route = createFileRoute("/privacy")({
  head: () => {
    const { appName } = getInstancePublicConfig(import.meta.env);
    return {
      meta: [
        { title: `Privacy notice | ${appName}` },
        { name: "description", content: `Privacy information for this ${appName} instance.` },
      ],
      links: [
        {
          rel: "canonical",
          href: `${configuredPublicOrigin(import.meta.env.VITE_PUBLIC_URL)}/privacy`,
        },
      ],
    };
  },
  component: PrivacyNotice,
});

function PrivacyNotice() {
  const { appName, privacyUrl, supportEmail } = getInstancePublicConfig(import.meta.env);
  return (
    <PublicAppChrome>
      <main className="min-h-screen bg-[#dfeaff] px-5 py-8 text-[#17213a] sm:px-8 sm:py-12">
        <div className="mx-auto max-w-4xl">
          <header className="rounded-[36px] border border-white/80 bg-white/90 p-7 shadow-[0_28px_80px_-45px_rgba(23,33,58,0.45)] backdrop-blur sm:p-12">
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-[#3478f6]">Legal</p>
            <h1 className="mt-4 max-w-2xl font-display text-4xl leading-[0.95] sm:text-6xl">
              Privacy for this instance.
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-[#17213a]/65 sm:text-lg">
              The instance operator controls how {appName} is deployed and how personal data is
              processed. This page is a neutral self-hosting notice, not a policy supplied by the
              software project.
            </p>
          </header>

          <div className="mt-5 grid gap-5 md:grid-cols-2">
            <NoticeSection title="Operator responsibility">
              The instance operator must publish a privacy policy appropriate for its deployment,
              enabled features, providers, users, and applicable law.
              {privacyUrl && (
                <>
                  {" "}
                  <a className="underline" href={privacyUrl}>
                    Read the operator&apos;s privacy policy.
                  </a>
                </>
              )}
            </NoticeSection>
            <NoticeSection title="Data and providers">
              Data processing depends on the features and third-party services configured by the
              instance operator. Review the operator&apos;s policy and the terms of any service you
              choose to connect.
            </NoticeSection>
            <NoticeSection title="Your controls">
              Account settings provide controls for profile data and connected services. See the{" "}
              <Link className="underline" to="/data-deletion">
                data-deletion instructions
              </Link>{" "}
              for account and integration removal options.
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
