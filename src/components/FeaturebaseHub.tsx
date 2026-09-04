import { useEffect, useRef, useState, type MouseEvent } from "react";
import { ExternalLink, HeartHandshake, Lightbulb, LifeBuoy, Megaphone } from "lucide-react";
import { onUnreadCountChange, showNewMessage, whenReady } from "featurebase-js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { captureProductEvent } from "@/lib/posthog";

export function FeaturebaseHub({
  portalUrl,
  inAppShell = false,
}: {
  portalUrl: string | null;
  inAppShell?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const messengerReadyRef = useRef(false);

  useEffect(() => {
    if (!portalUrl) return;
    let cancelled = false;
    try {
      whenReady(() => {
        if (cancelled) return;
        try {
          messengerReadyRef.current = true;
          onUnreadCountChange((count) => {
            if (!cancelled) setUnreadCount(count);
          });
        } catch {
          // The support portal remains available when Messenger is blocked.
          messengerReadyRef.current = false;
        }
      });
    } catch {
      messengerReadyRef.current = false;
    }

    return () => {
      cancelled = true;
      messengerReadyRef.current = false;
    };
  }, [portalUrl]);

  const openSupportMessenger = (event: MouseEvent<HTMLAnchorElement>) => {
    setOpen(false);
    captureProductEvent("support_messenger_opened");

    const messengerMounted = document.getElementById("fb-messenger-root") !== null;
    if (!messengerReadyRef.current || !messengerMounted) {
      captureProductEvent("support_portal_fallback_opened");
      return;
    }

    try {
      showNewMessage();
      event.preventDefault();
    } catch {
      // Keep the anchor's native navigation as a reliable fallback when a
      // privacy extension blocks Featurebase after the runtime reported ready.
      captureProductEvent("support_portal_fallback_opened");
    }
  };

  const itemClass =
    "flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  if (!portalUrl) return null;

  return (
    <>
      <div
        className={
          inAppShell
            ? "fixed right-3 top-1 z-50 lg:bottom-5 lg:right-5 lg:top-auto"
            : "fixed bottom-[calc(5.25rem+env(safe-area-inset-bottom))] right-3 z-50 sm:bottom-5 sm:right-5"
        }
      >
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Help, feedback and updates"
              title="Help, feedback and updates"
              onClick={() => captureProductEvent("customer_hub_opened")}
              className="relative inline-flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-[0_18px_45px_-16px_rgba(0,0,0,0.55)] ring-1 ring-white/30 transition hover:-translate-y-0.5 hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <HeartHandshake className="size-5" aria-hidden="true" />
              {unreadCount > 0 && (
                <span className="absolute -right-1.5 -top-1.5 grid min-w-5 place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-bold leading-5 text-white ring-2 ring-background">
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="end"
            sideOffset={10}
            className="max-h-[var(--radix-popover-content-available-height)] w-[min(22rem,calc(100vw-1.5rem))] overflow-y-auto overscroll-contain rounded-[28px] border-border/80 bg-popover/95 p-3 shadow-[0_28px_80px_-32px_rgba(0,0,0,0.55)] backdrop-blur-2xl"
          >
            <div className="px-3 pb-2 pt-1">
              <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                We are listening
              </div>
              <h2 className="mt-1 font-ui-display text-2xl">How can we help?</h2>
            </div>
            <a
              href={portalUrl}
              target="_blank"
              rel="noreferrer"
              className={itemClass}
              onClick={openSupportMessenger}
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-tint-sky text-tint-sky-fg">
                <LifeBuoy className="size-5" aria-hidden="true" />
              </span>
              <span>
                <span className="block text-sm font-semibold">Contact support</span>
                <span className="block text-xs text-muted-foreground">
                  Send a message to the Bento team
                </span>
              </span>
              <ExternalLink className="ml-auto size-3.5 text-muted-foreground" aria-hidden="true" />
            </a>
            <a
              href={portalUrl}
              target="_blank"
              rel="noreferrer"
              className={itemClass}
              onClick={() => {
                setOpen(false);
                captureProductEvent("feedback_portal_opened");
              }}
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-tint-lavender text-tint-lavender-fg">
                <Lightbulb className="size-5" aria-hidden="true" />
              </span>
              <span>
                <span className="block text-sm font-semibold">Share feedback</span>
                <span className="block text-xs text-muted-foreground">
                  Suggest an idea or report a bug
                </span>
              </span>
              <ExternalLink className="ml-auto size-3.5 text-muted-foreground" aria-hidden="true" />
            </a>
            <a
              href={`${portalUrl}/changelog`}
              target="_blank"
              rel="noreferrer"
              className={itemClass}
              onClick={() => {
                setOpen(false);
                captureProductEvent("product_updates_opened");
              }}
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-tint-mint text-tint-mint-fg">
                <Megaphone className="size-5" aria-hidden="true" />
              </span>
              <span>
                <span className="block text-sm font-semibold">Product updates</span>
                <span className="block text-xs text-muted-foreground">
                  See what is new in Bento
                </span>
              </span>
              <ExternalLink className="ml-auto size-3.5 text-muted-foreground" aria-hidden="true" />
            </a>
            <div className="mt-2 grid grid-cols-2 gap-2 border-t border-border/70 pt-3">
              <a
                href={portalUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center justify-center gap-1.5 rounded-2xl bg-muted px-3 py-2.5 text-xs font-semibold transition hover:bg-accent"
              >
                Help center <ExternalLink className="size-3" aria-hidden="true" />
              </a>
              <a
                href={`${portalUrl}/roadmap`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center justify-center gap-1.5 rounded-2xl bg-muted px-3 py-2.5 text-xs font-semibold transition hover:bg-accent"
              >
                Roadmap <ExternalLink className="size-3" aria-hidden="true" />
              </a>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </>
  );
}
