import type { ReactNode } from "react";

export function AppHeader({
  title,
  afterTitle,
  actions,
}: {
  title: string;
  afterTitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="sticky top-14 z-40 border-b border-border bg-background/95 backdrop-blur-xl lg:top-0">
      <div className="mx-auto flex h-[3.4rem] max-w-7xl items-center gap-3 px-4 sm:px-6">
        <h1
          className={`min-w-0 truncate font-ui-display text-xl text-foreground sm:text-2xl ${afterTitle ? "shrink-0" : "flex-1"}`}
        >
          {title}
        </h1>

        {afterTitle}

        {actions && (
          <div className="flex max-w-[42%] shrink-0 items-center justify-end gap-[0.326rem] sm:max-w-none sm:gap-[0.435rem] [&>a]:!gap-[0.435rem] [&>a]:!px-[0.65rem] [&>a]:!py-[0.435rem] [&>a]:!text-[0.76rem]/[1.1rem] [&>button]:!gap-[0.435rem] [&>button]:!px-[0.65rem] [&>button]:!py-[0.435rem] [&>button]:!text-[0.76rem]/[1.1rem] [&_svg]:!size-3.5 sm:[&>a]:!px-[0.76rem] sm:[&>button]:!px-[0.76rem]">
            {actions}
          </div>
        )}
      </div>
    </header>
  );
}
