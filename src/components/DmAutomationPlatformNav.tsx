import { Link } from "@tanstack/react-router";
import { SiFacebook, SiInstagram, SiX } from "react-icons/si";

const platforms = [
  {
    id: "instagram",
    to: "/auto-dms/instagram" as const,
    label: "Instagram",
    icon: SiInstagram,
  },
  {
    id: "facebook",
    to: "/auto-dms/facebook" as const,
    label: "Facebook",
    icon: SiFacebook,
  },
  {
    id: "twitter",
    to: "/auto-dms/twitter" as const,
    label: "X",
    icon: SiX,
  },
] as const;

export function DmAutomationPlatformNav({
  current,
}: {
  current: "hub" | "instagram" | "facebook" | "twitter";
}) {
  return (
    <nav
      aria-label="DM automation platforms"
      className="mb-6 grid w-full grid-cols-3 gap-1 rounded-xl border border-black/[0.06] bg-white p-1.5 shadow-sm sm:flex sm:w-fit"
    >
      {platforms.map(({ id, to, label, icon: Icon }) => {
        const selected = current === id;
        return (
          <Link
            key={id}
            to={to}
            className={`inline-flex items-center justify-center gap-2 rounded-lg px-2 py-2 text-xs font-semibold transition-colors sm:px-3.5 ${
              selected
                ? "bg-[#17213a] text-white"
                : "text-[#17213a]/55 hover:bg-[#f2f5fb] hover:text-[#17213a]"
            }`}
          >
            <Icon className="size-3.5" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
