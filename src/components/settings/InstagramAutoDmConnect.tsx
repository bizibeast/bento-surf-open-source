import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Unplug } from "lucide-react";
import { SiInstagram } from "react-icons/si";
import { toast } from "sonner";
import { beginInstagramConnection, disconnectInstagram } from "@/lib/social-connections.functions";
import { INSTAGRAM_CONNECTION_RETURN_TO } from "@/lib/settings-integrations";
import { MAX_SOCIAL_PROFILES_PER_PROVIDER } from "@/lib/social-scheduler";
import { micro } from "@/lib/micro-app-ui";

export type InstagramAutoDmAccount = {
  id: string;
  displayName: string;
  canPublish: boolean;
};

export function InstagramAutoDmConnect({
  connections,
  ready,
  onChanged,
}: {
  connections: InstagramAutoDmAccount[];
  ready: boolean;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const needsReconnect = connections.some((connection) => !connection.canPublish);
  const atProfileLimit = connections.length >= MAX_SOCIAL_PROFILES_PER_PROVIDER;
  const connect = useMutation({
    // Same full Instagram permission set as Social Media. One connect unlocks
    // Auto-DM and the Social scheduler together.
    mutationFn: () => beginInstagramConnection({ data: { intent: "scheduler" } }),
    onSuccess: ({ url }) => {
      window.sessionStorage.setItem(
        "instagramConnectionReturnTo",
        INSTAGRAM_CONNECTION_RETURN_TO.automation,
      );
      window.location.assign(url);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not start Instagram connection"),
  });
  const disconnect = useMutation({
    mutationFn: (id: string) => disconnectInstagram({ data: { id } }),
    onSuccess: () => {
      onChanged();
      void queryClient.invalidateQueries({ queryKey: ["integration-overview"] });
      void queryClient.invalidateQueries({ queryKey: ["instagram-auto-dm"] });
      void queryClient.invalidateQueries({ queryKey: ["social-scheduler"] });
      toast.success("Instagram account disconnected");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not disconnect Instagram"),
  });

  return (
    <div className="space-y-3 sm:max-w-md">
      <p className={micro.mutedXs}>
        One Instagram login powers Auto DMs and Social scheduling. Approve every permission Meta
        shows.
      </p>
      <div className="rounded-[22px] border border-black/[0.06] bg-white p-4 shadow-sm">
        <div className="flex items-center gap-3">
          <span
            className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-white shadow-sm ring-1 ring-black/[0.06]"
            style={{ color: "#E4405F" }}
          >
            <SiInstagram className="size-5" />
          </span>
          <div className="min-w-0 flex-1 font-semibold text-[#17213a]">Instagram</div>
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
              className={`size-2 rounded-full ${connection.canPublish ? "bg-emerald-500" : "bg-amber-500"}`}
            />
            <span className="min-w-0 flex-1 truncate">{connection.displayName}</span>
            {!connection.canPublish && (
              <span className="hidden text-[#b7790b] sm:inline">Reconnect for full access</span>
            )}
            <button
              type="button"
              aria-label={`Disconnect ${connection.displayName}`}
              onClick={() => {
                if (
                  window.confirm(
                    `Disconnect ${connection.displayName}? Its automations and scheduled Instagram posts will stop using this account.`,
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
