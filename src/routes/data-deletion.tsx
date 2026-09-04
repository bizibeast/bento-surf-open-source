import { createFileRoute, Link } from "@tanstack/react-router";
import { Instagram, ShieldCheck, Trash2 } from "lucide-react";
import { BentoFullLogo } from "@/components/BentoBrand";

export const Route = createFileRoute("/data-deletion")({
  head: () => ({
    meta: [
      { title: "Delete Your Data | bento.surf" },
      {
        name: "description",
        content: "How to disconnect Instagram, Facebook, X, or Reddit, or delete bento.surf data.",
      },
    ],
  }),
  component: DataDeletion,
});

function DataDeletion() {
  return (
    <main className="flex min-h-screen items-center bg-[#dfeaff] px-5 py-10 text-[#17213a] sm:px-8">
      <div className="mx-auto w-full max-w-4xl">
        <nav className="mb-8 flex items-center justify-between">
          <Link to="/" aria-label="bento.surf home">
            <BentoFullLogo className="h-8 w-auto" />
          </Link>
          <Link
            to="/privacy"
            className="text-sm font-medium text-[#17213a]/65 hover:text-[#17213a]"
          >
            Privacy policy
          </Link>
        </nav>

        <div className="grid gap-5 md:grid-cols-[1.05fr_0.95fr]">
          <section className="rounded-[36px] border border-white/80 bg-white/90 p-8 shadow-[0_28px_80px_-45px_rgba(23,33,58,0.45)] sm:p-11">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-[#3478f6] text-white">
              <ShieldCheck className="size-6" />
            </div>
            <h1 className="mt-7 font-display text-4xl leading-none sm:text-5xl">
              Your data stays yours.
            </h1>
            <p className="mt-5 text-base leading-7 text-[#17213a]/65">
              Disconnect a service without deleting your Bento, or permanently delete your account
              and associated data. Both controls are available inside the app.
            </p>
            <Link
              to="/settings"
              className="mt-7 inline-flex rounded-full bg-[#17213a] px-6 py-3 text-sm font-semibold text-white transition-transform hover:-translate-y-0.5"
            >
              Open settings
            </Link>
          </section>

          <div className="grid gap-5">
            <section className="rounded-[30px] border border-white/80 bg-white/85 p-7">
              <Instagram className="size-7 text-[#3478f6]" />
              <h2 className="mt-4 font-display text-2xl">Remove Instagram data</h2>
              <p className="mt-3 text-sm leading-6 text-[#17213a]/65">
                Open Instagram Auto-DM or Scheduler, choose the connected Instagram account, and
                select Disconnect. This removes its encrypted access token and stops scheduled or
                automated activity. You can also remove bento.surf from Instagram&apos;s
                connected-app settings; Meta will notify us to delete the connection.
              </p>
            </section>
            <section className="rounded-[30px] border border-white/80 bg-white/85 p-7">
              <h2 className="mt-0 font-display text-2xl">Remove Facebook data</h2>
              <p className="mt-3 text-sm leading-6 text-[#17213a]/65">
                Open Facebook Auto-DM or Scheduler, choose the connected Facebook Page, and select
                Disconnect. This removes its encrypted access token and stops scheduled or automated
                activity. You can also remove bento.surf from Facebook&apos;s connected-app
                settings; Meta will notify us to delete the connection.
              </p>
            </section>
            <section className="rounded-[30px] border border-white/80 bg-white/85 p-7">
              <h2 className="mt-0 font-display text-2xl">Remove X data</h2>
              <p className="mt-3 text-sm leading-6 text-[#17213a]/65">
                Open X Auto-DM or Scheduler, choose the connected X account, and select Disconnect.
                This removes its encrypted access token and stops scheduled or automated activity.
                You can also revoke bento.surf from X&apos;s connected-app settings.
              </p>
            </section>
            <section className="rounded-[30px] border border-white/80 bg-white/85 p-7">
              <h2 className="mt-0 font-display text-2xl">Remove Reddit data</h2>
              <p className="mt-3 text-sm leading-6 text-[#17213a]/65">
                Open Settings → Integrations, choose the connected Reddit account, and select
                Disconnect. This removes its encrypted access token and Reddit connection records,
                and stops scheduled Reddit posts. You can also revoke bento.surf from Reddit&apos;s
                authorized-application settings.
              </p>
            </section>
            <section className="rounded-[30px] border border-white/80 bg-white/85 p-7">
              <Trash2 className="size-7 text-rose-500" />
              <h2 className="mt-4 font-display text-2xl">Delete your account</h2>
              <p className="mt-3 text-sm leading-6 text-[#17213a]/65">
                In Settings, open Account and choose Delete account. If you cannot sign in, contact
                the instance operator from your account email. They may ask you to verify ownership
                before completing the request.
              </p>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}
