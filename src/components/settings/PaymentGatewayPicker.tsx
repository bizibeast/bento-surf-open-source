import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, Check, ExternalLink, LockKeyhole, Unplug } from "lucide-react";
import { SiRazorpay, SiStripe } from "react-icons/si";
import type {
  CreatorPaymentProvider,
  CreatorPaymentProviderDefinition,
} from "@/lib/payment-providers";
import { formatFeeBps } from "@/lib/payment-providers";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { IntegrationPanel } from "@/components/settings/IntegrationsOverview";
import { micro } from "@/lib/micro-app-ui";

type PaymentConnection = {
  id: string;
  provider: CreatorPaymentProvider;
  accountName: string;
  onboardingStatus: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
};

type PaymentProvider = CreatorPaymentProviderDefinition & {
  configured: boolean;
};

const PAYMENT_PROVIDER_RECOMMENDATIONS: Partial<Record<CreatorPaymentProvider, string>> = {
  stripe: "Best overall in supported countries",
  dodo: "Recommended for creators in India",
  polar: "Recommended for creators outside India",
  razorpay: "Recommended for registered businesses in India",
};

export type CreatorPaymentPickerSettings = {
  locked: boolean;
  feeBps: number;
  selectedProvider: CreatorPaymentProvider | null;
  recommendedProvider: "polar" | "dodo";
  connections: PaymentConnection[];
  providers: PaymentProvider[];
};

export function PaymentGatewayPicker({
  settings,
  loading,
  upgrade,
  pendingProvider,
  onConnect,
  onRefresh,
  onDisconnect,
}: {
  settings?: CreatorPaymentPickerSettings;
  loading: boolean;
  upgrade: ReactNode;
  pendingProvider?: CreatorPaymentProvider | null;
  onConnect: (provider: CreatorPaymentProvider) => void;
  onRefresh: (provider: CreatorPaymentProvider) => void;
  onDisconnect: (provider: CreatorPaymentProvider) => void;
}) {
  const [openProvider, setOpenProvider] = useState<CreatorPaymentProvider | null>(null);
  const [selectedProviderChoice, setSelectedProviderChoice] =
    useState<CreatorPaymentProvider | null>(null);
  const connections = settings?.connections || [];
  const currentConnection =
    connections.find((connection) => connection.provider === settings?.selectedProvider) ||
    connections.find(connectionReady) ||
    connections[0] ||
    null;
  const currentProvider = settings?.providers.find(
    (provider) => provider.id === currentConnection?.provider,
  );
  const chosenProvider = settings?.providers.find((provider) => provider.id === openProvider);
  const chosenConnection = connections.find((connection) => connection.provider === openProvider);
  const selectedProvider =
    selectedProviderChoice || currentConnection?.provider || settings?.selectedProvider || null;
  useEffect(() => {
    // Once the server confirms a connected provider, it becomes the single
    // source of truth instead of leaving an earlier local choice highlighted.
    if (settings?.selectedProvider) setSelectedProviderChoice(null);
  }, [settings?.selectedProvider]);

  const startConnection = (provider: CreatorPaymentProvider) => {
    setOpenProvider(null);
    onConnect(provider);
  };

  return (
    <IntegrationPanel
      id="integration-payments"
      title="Payments"
      meta={
        <span className="rounded-lg bg-[#e7f7ee] px-3 py-1.5 text-[11px] font-semibold text-[#197a4d]">
          {formatFeeBps(settings?.feeBps ?? 0)} Bento fee
        </span>
      }
    >
      {settings?.locked && (
        <div
          className={`mb-5 flex flex-col gap-4 ${micro.bannerInfo} sm:flex-row sm:items-center sm:justify-between`}
        >
          <div className="flex gap-3">
            <span className={`${micro.iconWell} size-10 shrink-0`}>
              <LockKeyhole className="size-4" />
            </span>
            <div>
              <div className="text-sm font-semibold text-[#17213a]">
                Connected checkout is a Store feature
              </div>
              <p className={`mt-1 ${micro.mutedXs}`}>
                Existing credentials remain safe. Upgrade to connect a payment gateway.
              </p>
            </div>
          </div>
          {upgrade}
        </div>
      )}

      <div
        className="grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-5 lg:grid-cols-8"
        aria-label="Payment gateway choices"
      >
        {(settings?.providers || []).map((provider) => {
          const connection = connections.find((item) => item.provider === provider.id);
          const ready = connection ? connectionReady(connection) : false;
          return (
            <button
              key={provider.id}
              type="button"
              disabled={settings?.locked || !provider.configured || loading}
              onClick={() => {
                setSelectedProviderChoice(provider.id);
                setOpenProvider(provider.id);
              }}
              className="group flex min-h-28 min-w-0 flex-col items-center rounded-xl px-1 py-2 text-center outline-none transition-[background-color,transform] duration-150 ease-out hover:bg-[#f7f9fd] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-[#3478f6]/35"
              aria-label={`${connection ? "Manage" : "Connect"} ${provider.name}`}
              aria-pressed={provider.id === selectedProvider}
              data-payment-provider-tile
            >
              <span className="relative">
                <PaymentProviderIcon provider={provider.id} />
                {ready && (
                  <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-lg bg-emerald-500 text-white ring-2 ring-white">
                    <Check className="size-3" strokeWidth={3} />
                  </span>
                )}
              </span>
              <span className="mt-2.5 max-w-full truncate text-xs font-semibold text-[#17213a]">
                {provider.name}
              </span>
              <span className="mt-0.5 text-[10px] text-[#17213a]/48">
                {connection ? (ready ? "Connected" : "Finish setup") : "Set up"}
              </span>
            </button>
          );
        })}
      </div>

      <p className={`mt-4 ${micro.mutedXs}`}>
        Bento charges no platform fee. Provider processing or merchant-of-record fees still apply.
        Payment credentials are encrypted and never shown after saving.
      </p>

      <Dialog
        open={Boolean(openProvider)}
        onOpenChange={(open) => {
          if (!open) setOpenProvider(null);
        }}
      >
        {chosenProvider && (
          <DialogContent className="w-[calc(100vw-1.5rem)] max-w-lg overflow-x-hidden overflow-y-auto rounded-[24px] p-0">
            <div className="border-b border-black/[0.06] p-5 sm:p-6">
              <DialogHeader>
                <div className="mb-4 flex items-center gap-4">
                  <PaymentProviderIcon provider={chosenProvider.id} size="large" />
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <DialogTitle className="font-ui-display text-2xl">
                        {chosenConnection ? `Manage ${chosenProvider.name}` : chosenProvider.name}
                      </DialogTitle>
                      {PAYMENT_PROVIDER_RECOMMENDATIONS[chosenProvider.id] && (
                        <span className="rounded-lg bg-[#dfeaff] px-2.5 py-1 text-[10px] font-semibold text-[#3478f6]">
                          Recommended
                        </span>
                      )}
                    </div>
                    <DialogDescription className="mt-1 text-left">
                      {chosenProvider.shortDescription}
                    </DialogDescription>
                  </div>
                </div>
              </DialogHeader>
            </div>

            <div className="space-y-5 p-5 sm:p-6">
              {currentConnection && currentConnection.provider !== chosenProvider.id ? (
                <div className="rounded-xl bg-[#fff8e8] p-4 text-sm leading-6 text-[#8a5a12]">
                  Disconnect {currentProvider?.name || "your current gateway"} before connecting{" "}
                  {chosenProvider.name}. Bento supports one payment gateway per store.
                </div>
              ) : (
                <>
                  <div>
                    <div className={micro.eyebrowMuted}>
                      {chosenConnection ? "Connection status" : "How it works"}
                    </div>
                    {chosenConnection ? (
                      <div className="mt-3 rounded-xl bg-[#f2f5fb] p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="font-semibold text-[#17213a]">
                              {chosenConnection.accountName}
                            </p>
                            <p className={`mt-1 ${micro.mutedXs}`}>
                              {connectionReady(chosenConnection)
                                ? "Ready to accept payments"
                                : "Complete the remaining provider setup"}
                            </p>
                          </div>
                          <span className="rounded-lg bg-white px-2.5 py-1 text-[10px] font-semibold text-[#17213a] ring-1 ring-black/[0.08]">
                            {chosenConnection.onboardingStatus}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <ol className="mt-3 space-y-3">
                        {chosenProvider.creatorSetupSteps.map((step, index) => (
                          <li key={step} className="flex gap-3 text-sm leading-6">
                            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[#17213a] text-[11px] font-semibold text-white">
                              {index + 1}
                            </span>
                            <span className="text-[#17213a]/55">{step}</span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>

                  <p className={`rounded-xl bg-[#f2f5fb] p-4 ${micro.mutedXs}`}>
                    {chosenProvider.setupNote}
                  </p>

                  <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <a
                      href={chosenProvider.docsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-11 items-center justify-center gap-1.5 rounded-lg px-4 text-sm font-semibold text-[#17213a]/55 transition-colors hover:bg-[#f2f5fb] hover:text-[#17213a]"
                    >
                      Official guide <ExternalLink className="size-3.5" />
                    </a>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      {chosenConnection ? (
                        <>
                          <button
                            type="button"
                            disabled={pendingProvider === chosenProvider.id}
                            onClick={() => onRefresh(chosenProvider.id)}
                            className={`${micro.btnOutline} h-11 disabled:opacity-50`}
                          >
                            {pendingProvider === chosenProvider.id ? "Checking…" : "Check status"}
                          </button>
                          <button
                            type="button"
                            disabled={pendingProvider === chosenProvider.id}
                            onClick={() => onDisconnect(chosenProvider.id)}
                            className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-destructive/10 px-4 text-sm font-semibold text-destructive disabled:opacity-50"
                          >
                            <Unplug className="size-4" /> Disconnect
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          disabled={
                            settings?.locked ||
                            !chosenProvider.configured ||
                            pendingProvider === chosenProvider.id
                          }
                          onClick={() => startConnection(chosenProvider.id)}
                          className={`${micro.btnPrimary} h-11 disabled:opacity-45`}
                        >
                          {pendingProvider === chosenProvider.id
                            ? "Opening…"
                            : `Continue with ${chosenProvider.name}`}
                          <ArrowRight className="size-4" />
                        </button>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </DialogContent>
        )}
      </Dialog>
    </IntegrationPanel>
  );
}

export function PaymentProviderIcon({
  provider,
  size = "default",
}: {
  provider: CreatorPaymentProvider;
  size?: "default" | "large";
}) {
  const container = "size-14 rounded-[18px]";
  const icon = size === "large" ? "size-7" : "size-6";
  return (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden bg-white shadow-sm ring-1 ring-black/[0.08] transition-[box-shadow,transform] duration-150 ease-out group-hover:-translate-y-0.5 group-hover:shadow-md ${container}`}
    >
      {provider === "stripe" && <SiStripe className={icon} color="#635bff" aria-hidden="true" />}
      {provider === "paypal" && <img src="/brands/paypal.svg" alt="" className={icon} />}
      {provider === "razorpay" && (
        <SiRazorpay className={icon} color="#2b84ea" aria-hidden="true" />
      )}
      {provider === "polar" && <img src="/brands/polar.svg" alt="" className={icon} />}
      {provider === "dodo" && (
        <img src="/brands/dodo-payments.svg?v=20260721" alt="" className="size-full object-cover" />
      )}
      {provider === "creem" && (
        <img src="/brands/creem.svg?v=20260721" alt="" className="size-full object-cover" />
      )}
    </span>
  );
}

function connectionReady(connection: PaymentConnection) {
  return Boolean(
    connection.chargesEnabled &&
    connection.payoutsEnabled &&
    connection.onboardingStatus === "complete",
  );
}
