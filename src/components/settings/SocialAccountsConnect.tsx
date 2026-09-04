import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Unplug } from "lucide-react";
import { useState, type ComponentType } from "react";
import { FaLinkedinIn } from "react-icons/fa";
import {
  SiFacebook,
  SiInstagram,
  SiReddit,
  SiThreads,
  SiTiktok,
  SiX,
  SiYoutube,
} from "react-icons/si";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DecodedImage } from "@/components/DecodedImage";
import { safeMediaUrl } from "@/lib/safe-url";
import { beginInstagramConnection, disconnectInstagram } from "@/lib/social-connections.functions";
import {
  beginSocialConnection,
  disconnectSocialConnection,
  socialProviderRequestedScopes,
} from "@/lib/social-oauth.functions";
import {
  FACEBOOK_CONNECTION_RETURN_TO,
  INSTAGRAM_CONNECTION_RETURN_TO,
  TWITTER_CONNECTION_RETURN_TO,
} from "@/lib/settings-integrations";
import {
  MAX_SOCIAL_PROFILES_PER_PROVIDER,
  PUBLIC_SOCIAL_PROVIDERS,
  SOCIAL_PROVIDER_DEFINITIONS,
  type SocialProvider,
} from "@/lib/social-scheduler";
import { micro } from "@/lib/micro-app-ui";

const PROVIDER_ICONS: Record<SocialProvider, ComponentType<{ className?: string }>> = {
  instagram: SiInstagram,
  facebook: SiFacebook,
  threads: SiThreads,
  tiktok: SiTiktok,
  linkedin: FaLinkedinIn,
  twitter: SiX,
  youtube: SiYoutube,
  reddit: SiReddit,
};

export type SocialConnectAccount = {
  id: string;
  provider: SocialProvider;
  displayName: string;
  avatarUrl?: string | null;
  canPublish: boolean;
  canAutomate?: boolean;
  scopes?: string[];
};

function accountHasCurrentScopes(provider: SocialProvider, connection: SocialConnectAccount) {
  return (
    provider === "instagram" ||
    socialProviderRequestedScopes(provider).every((scope) =>
      (connection.scopes || []).includes(scope),
    )
  );
}

function AccountAvatar({ account, ready }: { account: SocialConnectAccount; ready: boolean }) {
  const Icon = PROVIDER_ICONS[account.provider];
  const avatarUrl = safeMediaUrl(account.avatarUrl);
  return (
    <span
      className="relative flex size-10 shrink-0 items-center justify-center overflow-visible rounded-lg bg-white shadow-sm ring-1 ring-black/[0.08]"
      style={{ color: SOCIAL_PROVIDER_DEFINITIONS[account.provider].color }}
    >
      <Icon className="size-4" />
      {avatarUrl && (
        <DecodedImage
          src={avatarUrl}
          alt=""
          className="absolute inset-0 size-full rounded-lg object-cover"
        />
      )}
      <span
        aria-hidden="true"
        className={`absolute -bottom-0.5 -right-0.5 size-3 rounded-[4px] ring-2 ring-[#f7f9fd] ${ready ? "bg-emerald-500" : "bg-amber-500"}`}
      />
    </span>
  );
}

export function SocialAccountsConnect({
  connections,
  readiness,
  onChanged,
  query = "",
}: {
  connections: SocialConnectAccount[];
  readiness: Partial<Record<SocialProvider, boolean>>;
  onChanged: () => void;
  query?: string;
}) {
  const queryClient = useQueryClient();
  const [selectedProvider, setSelectedProvider] = useState<SocialProvider | null>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const providers = PUBLIC_SOCIAL_PROVIDERS.filter((provider) => {
    const name = SOCIAL_PROVIDER_DEFINITIONS[provider].name.toLowerCase();
    return !normalizedQuery || name.includes(normalizedQuery) || provider.includes(normalizedQuery);
  });

  const connect = useMutation({
    mutationFn: async (provider: SocialProvider) =>
      provider === "instagram"
        ? beginInstagramConnection({ data: { intent: "scheduler" } })
        : beginSocialConnection({ data: { provider } }),
    onSuccess: ({ url }, provider) => {
      if (provider === "instagram") {
        window.sessionStorage.setItem(
          "instagramConnectionReturnTo",
          INSTAGRAM_CONNECTION_RETURN_TO.social,
        );
      } else if (provider === "twitter") {
        window.sessionStorage.setItem(
          "twitterConnectionReturnTo",
          TWITTER_CONNECTION_RETURN_TO.social,
        );
      } else if (provider === "facebook") {
        window.sessionStorage.setItem(
          "facebookConnectionReturnTo",
          FACEBOOK_CONNECTION_RETURN_TO.social,
        );
      }
      window.location.assign(url);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not connect account"),
  });
  const disconnect = useMutation({
    mutationFn: ({ provider, id }: { provider: SocialProvider; id: string }) =>
      provider === "instagram"
        ? disconnectInstagram({ data: { id } })
        : disconnectSocialConnection({ data: { id } }),
    onSuccess: (_, { provider }) => {
      onChanged();
      void queryClient.invalidateQueries({ queryKey: ["integration-overview"] });
      void queryClient.invalidateQueries({ queryKey: ["social-scheduler"] });
      void queryClient.invalidateQueries({ queryKey: ["instagram-auto-dm"] });
      void queryClient.invalidateQueries({ queryKey: ["facebook-auto-dm"] });
      void queryClient.invalidateQueries({ queryKey: ["twitter-auto-dm"] });
      toast.success(`${SOCIAL_PROVIDER_DEFINITIONS[provider].name} disconnected`);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not disconnect account"),
  });

  const selectedConnections = selectedProvider
    ? connections.filter((connection) => connection.provider === selectedProvider)
    : [];
  const selectedDefinition = selectedProvider
    ? SOCIAL_PROVIDER_DEFINITIONS[selectedProvider]
    : null;
  const SelectedIcon = selectedProvider ? PROVIDER_ICONS[selectedProvider] : null;
  const selectedReady = selectedProvider ? Boolean(readiness[selectedProvider]) : false;
  const selectedNeedsReconnect = selectedProvider
    ? selectedConnections.some(
        (connection) =>
          !connection.canPublish ||
          connection.canAutomate === false ||
          !accountHasCurrentScopes(selectedProvider, connection),
      )
    : false;
  const selectedAtLimit = selectedConnections.length >= MAX_SOCIAL_PROFILES_PER_PROVIDER;

  return (
    <>
      {providers.length ? (
        <div className="grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-5 lg:grid-cols-8">
          {providers.map((provider) => {
            const definition = SOCIAL_PROVIDER_DEFINITIONS[provider];
            const Icon = PROVIDER_ICONS[provider];
            const providerConnections = connections.filter(
              (connection) => connection.provider === provider,
            );
            const count = providerConnections.length;
            return (
              <button
                key={provider}
                type="button"
                onClick={() => setSelectedProvider(provider)}
                aria-label={`Manage ${definition.name} integration, ${count} ${count === 1 ? "account" : "accounts"} connected`}
                className="group flex min-h-28 min-w-0 flex-col items-center rounded-xl px-1 py-2 text-center outline-none transition-[background-color,transform] duration-150 ease-out hover:bg-[#f7f9fd] active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-[#3478f6]/35"
              >
                <span
                  className="relative flex size-14 items-center justify-center rounded-[18px] bg-white shadow-sm ring-1 ring-black/[0.08] transition-[box-shadow,transform] duration-150 ease-out group-hover:-translate-y-0.5 group-hover:shadow-md"
                  style={{ color: definition.color }}
                >
                  <Icon className="size-6" />
                  {count > 0 && (
                    <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-lg bg-emerald-500 text-white ring-2 ring-white">
                      <Check className="size-3" strokeWidth={3} />
                    </span>
                  )}
                </span>
                <span className="mt-2.5 max-w-full truncate text-xs font-semibold text-[#17213a]">
                  {definition.name}
                </span>
                <span className="mt-0.5 text-[10px] tabular-nums text-[#17213a]/48">
                  {count
                    ? `${count} connected`
                    : readiness[provider]
                      ? "Available"
                      : "Setup pending"}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="py-8 text-sm text-[#17213a]/52">No social integrations match your search.</p>
      )}

      <Dialog
        open={Boolean(selectedProvider)}
        onOpenChange={(open) => {
          if (!open) setSelectedProvider(null);
        }}
      >
        {selectedProvider && selectedDefinition && SelectedIcon && (
          <DialogContent className="max-w-lg overflow-x-hidden overflow-y-auto rounded-[24px] p-0">
            <div className="border-b border-black/[0.06] p-5 sm:p-6">
              <DialogHeader>
                <div className="flex items-center gap-4 pr-10 text-left">
                  <span
                    className="flex size-14 shrink-0 items-center justify-center rounded-[18px] bg-white shadow-sm ring-1 ring-black/[0.08]"
                    style={{ color: selectedDefinition.color }}
                  >
                    <SelectedIcon className="size-6" />
                  </span>
                  <div className="min-w-0">
                    <DialogTitle className="font-ui-display text-2xl text-[#17213a]">
                      {selectedDefinition.name}
                    </DialogTitle>
                    <DialogDescription className="mt-1 text-left tabular-nums">
                      {selectedConnections.length} of {MAX_SOCIAL_PROFILES_PER_PROVIDER} accounts
                      connected
                    </DialogDescription>
                  </div>
                </div>
              </DialogHeader>
            </div>

            <div className="space-y-4 p-5 sm:p-6">
              {selectedConnections.length ? (
                <div className="space-y-2">
                  {selectedConnections.map((connection) => {
                    const ready =
                      connection.canPublish &&
                      connection.canAutomate !== false &&
                      accountHasCurrentScopes(selectedProvider, connection);
                    return (
                      <div
                        key={connection.id}
                        className="flex min-h-14 items-center gap-3 rounded-xl border border-black/[0.06] bg-[#f7f9fd] px-3.5 py-3"
                      >
                        <AccountAvatar account={connection} ready={ready} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-[#17213a]">
                            {connection.displayName}
                          </p>
                          {!ready && (
                            <p className="mt-0.5 text-[10px] text-[#a66b0a]">
                              Reconnect for analytics access
                            </p>
                          )}
                        </div>
                        <button
                          type="button"
                          aria-label={`Disconnect ${connection.displayName}`}
                          onClick={() =>
                            disconnect.mutate({ provider: selectedProvider, id: connection.id })
                          }
                          disabled={disconnect.isPending}
                          className="inline-flex size-10 items-center justify-center rounded-lg text-[#17213a]/45 transition-colors hover:bg-white hover:text-[#17213a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3478f6]/30"
                        >
                          <Unplug className="size-4" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-black/[0.1] bg-[#fafbfe] px-4 py-7 text-center">
                  <p className="text-sm font-semibold text-[#17213a]">No account connected yet</p>
                  <p className="mt-1 text-xs leading-5 text-[#17213a]/50">
                    Connect one now. You can add a second profile later.
                  </p>
                </div>
              )}

              <button
                type="button"
                disabled={
                  !selectedReady ||
                  connect.isPending ||
                  (selectedAtLimit && !selectedNeedsReconnect)
                }
                onClick={() => connect.mutate(selectedProvider)}
                className={`${micro.btnPrimary} w-full justify-center disabled:bg-[#f2f5fb] disabled:text-[#17213a]/45 disabled:shadow-none disabled:hover:translate-y-0`}
              >
                {connect.isPending
                  ? "Opening…"
                  : selectedReady
                    ? selectedNeedsReconnect
                      ? "Reconnect"
                      : selectedAtLimit
                        ? "2 / 2"
                        : selectedConnections.length
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
