import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { SiFacebook, SiInstagram, SiX } from "react-icons/si";
import { AppHeader } from "@/components/AppHeader";
import { MicroAppPanel } from "@/components/MicroAppPanel";
import { micro } from "@/lib/micro-app-ui";

export const Route = createFileRoute("/_authenticated/auto-dms/")({
  head: () => ({ meta: [{ title: "DM automation | bento.surf" }] }),
  component: DmAutomationHubPage,
});

function DmAutomationHubPage() {
  return (
    <main className={`relative overflow-x-clip ${micro.shell}`}>
      <AppHeader title="DM automation" />
      <div className={micro.main}>
        <p className={micro.eyebrow}>Auto-DM</p>
        <h2 className="mt-1 font-ui-display text-3xl">
          Reply automatically on Instagram, Facebook, and X.
        </h2>
        <p className={`mt-2 max-w-2xl ${micro.muted}`}>
          Connect an account, pick a trigger like a comment, reply, or inbound message, and Bento
          sends the reply through the official API.
        </p>
        <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <PlatformCard
            to="/auto-dms/instagram"
            icon={<SiInstagram className="size-6" />}
            tint="bg-gradient-to-br from-[#feda75] via-[#d62976] to-[#4f5bd5] text-white"
            title="Instagram Auto-DM"
            description="Reply when someone comments, DMs, replies to a Story, comments on a Live, or shares your post."
          />
          <PlatformCard
            to="/auto-dms/facebook"
            icon={<SiFacebook className="size-6" />}
            tint="bg-[#1877f2] text-white"
            title="Facebook Auto-DM"
            description="Reply when someone comments on your Page post or sends you a Messenger DM."
          />
          <PlatformCard
            to="/auto-dms/twitter"
            icon={<SiX className="size-6" />}
            tint="bg-[#111111] text-white"
            title="X Auto-DM"
            description="Reply when someone replies, likes, or reposts your post, or sends you a DM."
          />
        </div>
      </div>
    </main>
  );
}

function PlatformCard({
  to,
  icon,
  tint,
  title,
  description,
}: {
  to: "/auto-dms/instagram" | "/auto-dms/facebook" | "/auto-dms/twitter";
  icon: ReactNode;
  tint: string;
  title: string;
  description: string;
}) {
  return (
    <Link to={to} className="block">
      <MicroAppPanel className="h-full transition hover:-translate-y-0.5">
        <div className={`flex size-14 items-center justify-center rounded-[20px] ${tint}`}>
          {icon}
        </div>
        <h3 className="mt-5 font-ui-display text-2xl">{title}</h3>
        <p className={`mt-2 ${micro.muted}`}>{description}</p>
        <span className={`${micro.btnInk} mt-6`}>
          Open <ArrowRight className="size-4" />
        </span>
      </MicroAppPanel>
    </Link>
  );
}
