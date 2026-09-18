import { BadgeCheck } from "lucide-react";

/** A verification mark is only shown for verified, paid creators. */
export function VerifiedBadge({
  className = "size-5",
  active = true,
}: {
  className?: string;
  active?: boolean;
}) {
  if (!active) return null;
  return (
    <BadgeCheck
      className={`${className} shrink-0`}
      style={{ color: "#fff", fill: "#1d9bf0" }}
      aria-label="Verified creator"
    />
  );
}
