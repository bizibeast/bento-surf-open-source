import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type PostingIssue = { message: string; connectionId?: string };

/** A blocked action stays focusable so its explanation also works without a mouse. */
export function SchedulerActionButton({
  label,
  children,
  issues,
  onAction,
  onOpenConnection,
  className,
  busy,
}: {
  label: string;
  children: ReactNode;
  issues: PostingIssue[];
  onAction: () => void;
  onOpenConnection: (connectionId: string) => void;
  className?: string;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const descriptionId = useId();
  const headingId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blocked = issues.length > 0;

  function cancelClose() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }

  function closeAfterLeave() {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 180);
  }

  function closeAfterBlur(target: EventTarget | null) {
    if (
      target instanceof Node &&
      (buttonRef.current?.contains(target) || contentRef.current?.contains(target))
    )
      return;
    closeAfterLeave();
  }

  useEffect(() => {
    if (!blocked) setOpen(false);
  }, [blocked]);
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  return (
    <Popover open={open && blocked} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={buttonRef}
          type="button"
          aria-label={label}
          aria-disabled={blocked || undefined}
          aria-busy={busy || undefined}
          aria-describedby={blocked ? descriptionId : undefined}
          title={blocked ? undefined : label}
          className={cn(
            className,
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            blocked && "cursor-help opacity-60 shadow-none hover:translate-y-0",
          )}
          onPointerEnter={(event) => {
            if (event.pointerType === "touch" || !blocked) return;
            cancelClose();
            setOpen(true);
          }}
          onPointerLeave={(event) => {
            if (event.pointerType !== "touch") closeAfterLeave();
          }}
          onFocus={() => {
            cancelClose();
            if (blocked) setOpen(true);
          }}
          onBlur={(event) => closeAfterBlur(event.relatedTarget)}
          onClick={(event) => {
            // Prevent the popover trigger's toggle and never execute a blocked action.
            event.preventDefault();
            cancelClose();
            if (blocked) setOpen(true);
            else onAction();
          }}
        >
          {children}
        </button>
      </PopoverTrigger>
      {blocked && (
        <span id={descriptionId} className="sr-only">
          {issues.map((issue) => issue.message).join("\n")}
        </span>
      )}
      <PopoverContent
        ref={contentRef}
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        aria-labelledby={headingId}
        className="z-[80] w-[min(24rem,calc(100vw-1.5rem))] max-h-[min(26rem,var(--radix-popover-content-available-height))] overflow-y-auto overscroll-contain rounded-xl p-4 text-sm shadow-xl"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={cancelClose}
        onPointerLeave={(event) => {
          if (event.pointerType !== "touch") closeAfterLeave();
        }}
        onFocusCapture={cancelClose}
        onBlurCapture={(event) => closeAfterBlur(event.relatedTarget)}
      >
        <div className="mb-2 flex items-center justify-between gap-3">
          <p id={headingId} className="font-semibold">
            {label === "Publish now" ? "To publish this post" : "To schedule this post"}
          </p>
          <button
            type="button"
            aria-label="Close posting requirements"
            onClick={() => setOpen(false)}
            className="-mr-2 -mt-2 flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        <ul className="space-y-3 pl-4 text-sm leading-relaxed text-muted-foreground list-disc marker:text-muted-foreground/60">
          {issues.map((issue, index) => (
            <li key={`${issue.message}-${index}`} className="whitespace-pre-line break-words pl-1">
              {issue.connectionId ? (
                <button
                  type="button"
                  className="text-left underline decoration-border underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    setOpen(false);
                    onOpenConnection(issue.connectionId!);
                  }}
                >
                  {issue.message}
                </button>
              ) : (
                issue.message
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
