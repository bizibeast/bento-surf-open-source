import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Unplug } from "lucide-react";
import { useState, type ComponentType, type ReactNode } from "react";
import { FcGoogle } from "react-icons/fc";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  beginFathomConnection,
  beginGoogleCalendarConnection,
  disconnectBookingConnection,
  setDefaultBookingConnection,
} from "@/lib/booking.functions";
import { micro } from "@/lib/micro-app-ui";

export type BookingConnectAccount = {
  id: string;
  email: string | null;
  displayName: string | null;
  status: string;
  isDefault?: boolean;
};

export type BookingProvider = "google" | "fathom";

function FathomLogo({ className = "" }: { className?: string }) {
  return <img src="/brands/fathom.png" alt="" className={`${className} object-contain`} />;
}

const PROVIDERS: Array<{
  id: BookingProvider;
  title: string;
  search: string;
  icon: ComponentType<{ className?: string }>;
  color: string;
}> = [
  {
    id: "google",
    title: "Google Calendar & Meet",
    search: "meetings google calendar meet",
    icon: FcGoogle,
    color: "#4285F4",
  },
  {
    id: "fathom",
    title: "Fathom recordings",
    search: "meetings fathom calls recordings",
    icon: FathomLogo,
    color: "#3478F6",
  },
];

export function BookingAccountsConnect({
  calendarConnections,
  fathomConnections,
  googleReady,
  fathomReady,
  onChanged,
  query = "",
}: {
  calendarConnections: BookingConnectAccount[];
  fathomConnections: BookingConnectAccount[];
  googleReady: boolean;
  fathomReady: boolean;
  onChanged: () => void;
  query?: string;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<BookingProvider | null>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const shownProviders = PROVIDERS.filter(
    (provider) =>
      !normalizedQuery ||
      provider.title.toLowerCase().includes(normalizedQuery) ||
      provider.search.includes(normalizedQuery),
  );
  const selectedProvider = PROVIDERS.find((provider) => provider.id === selected) || null;
  const connections = selected === "google" ? calendarConnections : fathomConnections;
  const ready = selected === "google" ? googleReady : fathomReady;

  const connect = useMutation({
    mutationFn: (type: BookingProvider) =>
      type === "google" ? beginGoogleCalendarConnection() : beginFathomConnection(),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not connect"),
  });
  const makeDefault = useMutation({
    mutationFn: ({ type, id }: { type: BookingProvider; id: string }) =>
      setDefaultBookingConnection({ data: { type, id } }),
    onSuccess: () => {
      onChanged();
      void queryClient.invalidateQueries({ queryKey: ["booking-workspace"] });
      toast.success("Default account updated");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not update default account"),
  });
  const disconnect = useMutation({
    mutationFn: ({ type, id }: { type: BookingProvider; id: string }) =>
      disconnectBookingConnection({ data: { type, id } }),
    onSuccess: () => {
      onChanged();
      void queryClient.invalidateQueries({ queryKey: ["booking-workspace"] });
      toast.success("Account disconnected");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not disconnect this account"),
  });

  return (
    <>
      <div className="grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-5 lg:grid-cols-8">
        {shownProviders.map((provider) => {
          const providerConnections =
            provider.id === "google" ? calendarConnections : fathomConnections;
          const count = providerConnections.length;
          const providerReady = provider.id === "google" ? googleReady : fathomReady;
          return (
            <button
              key={provider.id}
              type="button"
              onClick={() => setSelected(provider.id)}
              aria-label={`Manage ${provider.title} integration, ${count} ${count === 1 ? "account" : "accounts"} connected`}
              className="group flex min-h-28 min-w-0 flex-col items-center rounded-xl px-1 py-2 text-center outline-none transition-[background-color,transform] duration-150 ease-out hover:bg-[#f7f9fd] active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-[#3478f6]/35"
            >
              <BookingProviderMark provider={provider.id} connected={count > 0} />
              <span className="mt-2.5 max-w-full text-xs font-semibold leading-4 text-[#17213a]">
                {provider.title}
              </span>
              <span className="mt-0.5 text-[10px] tabular-nums text-[#17213a]/48">
                {count ? `${count} connected` : providerReady ? "Available" : "Setup pending"}
              </span>
            </button>
          );
        })}
      </div>

      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        {selected && selectedProvider && (
          <DialogContent className="max-w-lg overflow-x-hidden overflow-y-auto rounded-[24px] p-0">
            <div className="border-b border-black/[0.06] p-5 sm:p-6">
              <DialogHeader>
                <div className="flex items-center gap-4 pr-10 text-left">
                  <BookingProviderMark
                    provider={selectedProvider.id}
                    connected={connections.length > 0}
                  />
                  <div className="min-w-0">
                    <DialogTitle className="font-ui-display text-2xl text-[#17213a]">
                      {selectedProvider.title}
                    </DialogTitle>
                    <DialogDescription className="mt-1 text-left tabular-nums">
                      {connections.length} {connections.length === 1 ? "account" : "accounts"}
                      connected
                    </DialogDescription>
                  </div>
                </div>
              </DialogHeader>
            </div>

            <div className="space-y-4 p-5 sm:p-6">
              {connections.length ? (
                <div className="space-y-2">
                  {connections.map((connection) => (
                    <div
                      key={connection.id}
                      className="flex min-h-14 items-center gap-3 rounded-xl border border-black/[0.06] bg-[#f7f9fd] px-3.5 py-3"
                    >
                      <span
                        className={`size-2.5 shrink-0 rounded-[4px] ${connection.status === "active" ? "bg-emerald-500" : "bg-rose-500"}`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-[#17213a]">
                          {connection.displayName || connection.email || "Connected account"}
                        </p>
                        {connection.isDefault && (
                          <p className="mt-0.5 text-[10px] font-semibold text-[#3478f6]">Default</p>
                        )}
                      </div>
                      {!connection.isDefault && (
                        <button
                          type="button"
                          onClick={() => makeDefault.mutate({ type: selected, id: connection.id })}
                          disabled={makeDefault.isPending}
                          className="min-h-10 rounded-lg px-2 text-xs font-semibold text-[#3478f6] transition-colors hover:bg-white"
                        >
                          Make default
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label={`Disconnect ${connection.displayName || connection.email || "account"}`}
                        onClick={() => disconnect.mutate({ type: selected, id: connection.id })}
                        disabled={disconnect.isPending}
                        className="inline-flex size-10 items-center justify-center rounded-lg text-[#17213a]/45 transition-colors hover:bg-white hover:text-[#17213a]"
                      >
                        <Unplug className="size-4" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-black/[0.1] bg-[#fafbfe] px-4 py-7 text-center">
                  <p className="text-sm font-semibold text-[#17213a]">No account connected yet</p>
                  <p className="mt-1 text-xs leading-5 text-[#17213a]/50">
                    Connect your first account to use it across Bento.
                  </p>
                </div>
              )}
              <button
                type="button"
                disabled={!ready || connect.isPending}
                onClick={() => connect.mutate(selected)}
                className={`${micro.btnPrimary} w-full justify-center disabled:bg-[#f2f5fb] disabled:text-[#17213a]/45 disabled:shadow-none`}
              >
                {connect.isPending
                  ? "Opening…"
                  : ready
                    ? connections.length
                      ? "Connect another"
                      : "Connect"
                    : "Setup pending"}
              </button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

export function BookingProviderMark({
  provider,
  connected = false,
}: {
  provider: BookingProvider;
  connected?: boolean;
}) {
  const definition = PROVIDERS.find((item) => item.id === provider)!;
  const Icon = definition.icon;
  return (
    <ProviderIcon
      icon={<Icon className="size-6" />}
      color={definition.color}
      connected={connected}
    />
  );
}

function ProviderIcon({
  icon,
  color,
  connected,
}: {
  icon: ReactNode;
  color: string;
  connected: boolean;
}) {
  return (
    <span
      className="relative flex size-14 shrink-0 items-center justify-center rounded-[18px] bg-white shadow-sm ring-1 ring-black/[0.08]"
      style={{ color }}
    >
      {icon}
      {connected && (
        <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-lg bg-emerald-500 text-white ring-2 ring-white">
          <Check className="size-3" strokeWidth={3} />
        </span>
      )}
    </span>
  );
}
