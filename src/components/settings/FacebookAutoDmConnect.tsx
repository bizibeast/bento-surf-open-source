import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Unplug } from "lucide-react";
import { SiFacebook } from "react-icons/si";
import { toast } from "sonner";
import { beginSocialConnection, disconnectSocialConnection } from "@/lib/social-oauth.functions";
import { FACEBOOK_CONNECTION_RETURN_TO } from "@/lib/settings-integrations";
import { MAX_SOCIAL_PROFILES_PER_PROVIDER } from "@/lib/social-scheduler";
import { micro } from "@/lib/micro-app-ui";

export type FacebookAutoDmAccount = {
  id: string;
  displayName: string;
  canAutomate: boolean;
};

export function FacebookAutoDmConnect({
  connections,
  ready,
  onChanged,
}: {
  connections: FacebookAutoDmAccount[];
  ready: boolean;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const needsReconnect = connections.some((connection) => !connection.canAutomate);
  const atProfileLimit = connections.length >= MAX_SOCIAL_PROFILES_PER_PROVIDER;
  const connect = useMutation({
    mutationFn: () => beginSocialConnection({ data: { provider: "facebook" } }),
    onSuccess: ({ url }) => {
      window.sessionStorage.setItem(
        "facebookConnectionReturnTo",
        FACEBOOK_CONNECTION_RETURN_TO.autoDm,
      );
      window.location.assign(url);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not start Facebook connection"),
  });
  const disconnect = useMutation({
    mutationFn: (id: string) => disconnectSocialConnection({ data: { id } }),
    onSuccess: () => {
      onChanged();
      void queryClient.invalidateQueries({ queryKey: ["integration-overview"] });
      void queryClient.invalidateQueries({ queryKey: ["facebook-auto-dm"] });
      void queryClient.invalidateQueries({ queryKey: ["social-scheduler"] });
      toast.success("Facebook Page disconnected");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not disconnect Facebook"),
  });

  return (
    <div className="space-y-3 sm:max-w-md">
      <p className={micro.mutedXs}>
        One Facebook login powers Auto DMs and Social scheduling. Approve comment and Messenger
        access when Meta asks.
      </p>
      <div className="rounded-[22px] border border-black/[0.06] bg-white p-4 shadow-sm">
        <div className="flex items-center gap-3">
          <span
            className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-white shadow-sm ring-1 ring-black/[0.06]"
            style={{ color: "#1877f2" }}
          >
            <SiFacebook className="size-5" />
          </span>
          <div className="min-w-0 flex-1 font-semibold text-[#17213a]">Facebook</div>
          <button
            type="button"
            disabled={!ready || connect.isPending || (atProfileLimit && !needsReconnect)}
            onClick={() => connect.mutate()}
            className={`${micro.btnPrimaryCompact} shrink-0 disabled:bg-[#f2f5fb] disabled:text-[#17213a]/45 disabled:shadow-none disabled:hover:translate-y-0`}
          >
            {connect.isPending
              ? "Opening…"
              : ready
                ? needsReconnect
                  ? "Reconnect"
                  : atProfileLimit
                    ? "2 / 2"
                    : connections.length
                      ? "Connect another"
                      : "Connect"
                : "Setup pending"}
          </button>
        </div>
        {connections.map((connection) => (
          <div
            key={connection.id}
            className="mt-3 flex items-center gap-2 rounded-2xl bg-[#f2f5fb] px-3 py-2.5 text-xs text-[#17213a]"
          >
            <span
              className={`size-2 rounded-full ${connection.canAutomate ? "bg-emerald-500" : "bg-amber-500"}`}
            />
            <span className="min-w-0 flex-1 truncate">{connection.displayName}</span>
            {!connection.canAutomate && (
              <span className="hidden text-[#b7790b] sm:inline">
                Reconnect for Messenger access
              </span>
            )}
            <button
              type="button"
              aria-label={`Disconnect ${connection.displayName}`}
              onClick={() => {
                if (
                  window.confirm(
                    `Disconnect ${connection.displayName}? Its automations and scheduled Facebook posts will stop using this Page.`,
                  )
                ) {
                  disconnect.mutate(connection.id);
                }
              }}
              disabled={disconnect.isPending}
              className="text-[#17213a]/45 hover:text-[#17213a]"
            >
              <Unplug className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
