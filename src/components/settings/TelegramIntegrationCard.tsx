import { useMutation } from "@tanstack/react-query";
import { Check, Unplug } from "lucide-react";
import { useEffect, useState } from "react";
import { SiTelegram } from "react-icons/si";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { beginTelegramConnection, disconnectTelegramConnection } from "@/lib/telegram.functions";
import { micro } from "@/lib/micro-app-ui";

export type TelegramConnectionView = {
  id: string;
  displayName: string | null;
  status: string;
  lastSuccessAt: string | null;
  lastError: string | null;
};

export function TelegramIntegrationCard({
  connection,
  ready,
  botUsername,
  onChanged,
}: {
  connection: TelegramConnectionView | null;
  ready: boolean;
  botUsername: string | null;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [awaiting, setAwaiting] = useState(false);
  const connected = connection?.status === "active";

  useEffect(() => {
    if (!awaiting) return;
    const refresh = () => onChanged();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [awaiting, onChanged]);

  const connect = useMutation({
    mutationFn: () => beginTelegramConnection(),
    onSuccess: ({ url }) => {
      setAwaiting(true);
      window.open(url, "_blank", "noopener,noreferrer");
      onChanged();
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not connect Telegram"),
  });
  const disconnect = useMutation({
    mutationFn: () => disconnectTelegramConnection({ data: { id: connection?.id || "" } }),
    onSuccess: () => {
      setAwaiting(false);
      setOpen(false);
      onChanged();
      toast.success("Telegram disconnected");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not disconnect Telegram"),
  });

  const status = connected
    ? connection.displayName || "Connected"
    : ready
      ? awaiting
        ? "Waiting for /start"
        : "Available"
      : "Setup pending";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Manage Telegram integration, ${connected ? "connected" : "not connected"}`}
        className="group flex min-h-28 min-w-0 flex-col items-center rounded-xl px-1 py-2 text-center outline-none transition-[background-color,transform] duration-150 ease-out hover:bg-[#f7f9fd] active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-[#3478f6]/35"
      >
        <span className="relative flex size-14 items-center justify-center rounded-[18px] bg-white text-[#229ED9] shadow-sm ring-1 ring-black/[0.08] transition-[box-shadow,transform] duration-150 ease-out group-hover:-translate-y-0.5 group-hover:shadow-md">
          <SiTelegram className="size-7" />
          {connected && (
            <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-lg bg-emerald-500 text-white ring-2 ring-white">
              <Check className="size-3" strokeWidth={3} />
            </span>
          )}
        </span>
        <span className="mt-2.5 text-xs font-semibold text-[#17213a]">Telegram</span>
        <span className="mt-0.5 max-w-full truncate text-[10px] text-[#17213a]/48">{status}</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md rounded-[24px] p-0">
          <div className="border-b border-black/[0.06] p-5 sm:p-6">
            <DialogHeader>
              <div className="flex items-center gap-4 pr-10 text-left">
                <span className="flex size-14 items-center justify-center rounded-[18px] bg-white text-[#229ED9] shadow-sm ring-1 ring-black/[0.08]">
                  <SiTelegram className="size-7" />
                </span>
                <div>
                  <DialogTitle className="font-ui-display text-2xl text-[#17213a]">
                    Telegram
                  </DialogTitle>
                  <DialogDescription className="mt-1 text-left">
                    Talk to your Content Agent and receive draft-ready alerts.
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>
          </div>
          <div className="space-y-3 p-5 sm:p-6">
            {!ready ? (
              <p className="rounded-xl bg-[#f7f9fd] p-4 text-sm text-[#17213a]/60">
                Awaiting Bento bot configuration.
              </p>
            ) : connected ? (
              <div className="flex items-center gap-3 rounded-xl bg-[#f7f9fd] p-4">
                <span className="size-2.5 rounded-full bg-emerald-500" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-[#17213a]">
                    {connection.displayName || "Telegram account"}
                  </p>
                  <p className={micro.mutedXs}>Active</p>
                </div>
                <button
                  type="button"
                  aria-label="Disconnect Telegram"
                  disabled={disconnect.isPending}
                  onClick={() => disconnect.mutate()}
                  className="inline-flex size-10 items-center justify-center rounded-lg text-[#17213a]/45 hover:bg-white hover:text-[#17213a]"
                >
                  <Unplug className="size-4" />
                </button>
              </div>
            ) : (
              <p className="rounded-xl bg-[#f7f9fd] p-4 text-sm leading-6 text-[#17213a]/60">
                Open Telegram, press Start, and Bento will connect this private chat to your Agent.
              </p>
            )}

            {connection?.lastError && (
              <p className="rounded-xl bg-rose-50 p-3 text-xs text-rose-700">
                {connection.lastError}
              </p>
            )}

            {connected && botUsername ? (
              <button
                type="button"
                onClick={() =>
                  window.open(`https://t.me/${botUsername}`, "_blank", "noopener,noreferrer")
                }
                className={`${micro.btnPrimary} w-full justify-center`}
              >
                Open Telegram
              </button>
            ) : (
              <button
                type="button"
                disabled={!ready || connect.isPending}
                onClick={() => connect.mutate()}
                className={`${micro.btnPrimary} w-full justify-center disabled:bg-[#f2f5fb] disabled:text-[#17213a]/45 disabled:shadow-none`}
              >
                {connect.isPending ? "Opening…" : "Connect Telegram"}
              </button>
            )}

            {awaiting && !connected && (
              <button
                type="button"
                onClick={onChanged}
                className={`${micro.btnOutline} w-full justify-center`}
              >
                Check connection
              </button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
