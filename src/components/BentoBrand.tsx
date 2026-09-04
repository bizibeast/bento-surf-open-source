export const BENTO_ICON_SRC = "/branding/bento-logo.svg";
export const BENTO_FULL_LOGO_SRC = "/branding/bento-full-logo.svg";

export function BentoIcon({ className = "size-8" }: { className?: string }) {
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden ${className}`}
    >
      <img src={BENTO_ICON_SRC} alt="" aria-hidden="true" className="size-full object-contain" />
    </span>
  );
}

export function BentoFullLogo({ className = "h-8 w-auto" }: { className?: string }) {
  return <img src={BENTO_FULL_LOGO_SRC} alt="bento.surf" className={className} />;
}

export function BentoBrand({
  className = "",
  iconClassName = "size-8",
  textClassName = "",
}: {
  className?: string;
  iconClassName?: string;
  textClassName?: string;
}) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-2 ${className}`}>
      <BentoIcon className={iconClassName} />
      <span className={`truncate font-semibold ${textClassName}`}>bento.surf</span>
    </span>
  );
}
