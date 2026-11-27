import type { ReactNode } from "react";

export function AppHeader({
  title,
  afterTitle,
  actions,
  fullWidth = false,
}: {
  title: string;
  afterTitle?: ReactNode;
  actions?: ReactNode;
  fullWidth?: boolean;
}) {
  return (
    <header className="sticky top-14 z-40 border-b border-border bg-background/95 backdrop-blur-sm lg:top-0">
      <div
        className={`flex h-14 items-center gap-4 px-4 sm:px-8 ${fullWidth ? "w-full" : "mx-auto max-w-7xl"}`}
      >
        <h1
          className={`min-w-0 truncate font-ui-display text-xl text-foreground sm:text-2xl ${afterTitle ? "shrink-0" : "flex-1"}`}
        >
          {title}
        </h1>

        {afterTitle}

        {actions && (
          <div className="flex shrink-0 items-center justify-end gap-2 [&>a]:min-h-8 [&>a]:gap-2 [&>a]:rounded-[8px] [&>a]:px-3 [&>a]:py-2 [&>a]:text-xs [&>button]:min-h-8 [&>button]:gap-2 [&>button]:rounded-[8px] [&>button]:px-3 [&>button]:py-2 [&>button]:text-xs [&_svg]:size-4">
            {actions}
          </div>
        )}
      </div>
    </header>
  );
}
