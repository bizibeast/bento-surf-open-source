import { BadgeCheck } from "lucide-react";

/** Paid plans are blue; Free keeps the same mark as a quiet grey outline. */
export function VerifiedBadge({
  className = "size-5",
  active = true,
}: {
  className?: string;
  active?: boolean;
}) {
  return (
    <BadgeCheck
      className={`${className} shrink-0 ${active ? "fill-[#3478f6] text-white" : "fill-transparent text-slate-300"}`}
      aria-label={active ? "Verified creator" : "Verification available on paid plans"}
    />
  );
}
