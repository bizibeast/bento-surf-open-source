import { getWorkspaceSession } from "@/lib/workspace.functions";
import { useId } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getAutoDmDelay, setAutoDmDelay } from "@/lib/auto-dm-delay.functions";
import { AUTO_DM_DELAYS, type autoDmDelaySchema } from "@/lib/auto-dm-delay";
import type { z } from "zod";
import { toast } from "sonner";

export function AutoDmDelaySettings() {
  const id = useId();
  const client = useQueryClient();
  const { data: workspace } = useQuery({
    queryKey: ["workspace-session"],
    queryFn: () => getWorkspaceSession(),
    staleTime: 60_000,
  });
  const workspaceId = (workspace as { workspaceId?: string } | undefined)?.workspaceId;
  const key = ["auto-dm-delay", workspaceId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => getAutoDmDelay(),
    enabled: Boolean(workspaceId),
  });
  const mutation = useMutation({
    mutationFn: ({
      delaySeconds,
    }: {
      delaySeconds: z.infer<typeof autoDmDelaySchema>;
      workspaceId: string;
    }) => setAutoDmDelay({ data: { delaySeconds } }),
    onSuccess: (data, variables) => {
      client.setQueryData(["auto-dm-delay", variables.workspaceId], data);
      toast.success("Reply delay saved for all Auto DMs");
    },
    onError: () => toast.error("Reply delay could not be saved. Please try again."),
  });
  return (
    <div className="my-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border/60 p-3">
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="text-sm font-medium">
          Auto DM reply delay
        </label>
        <p className="mt-1 text-xs text-muted-foreground">
          Applies to comment replies and every message step on Instagram, Facebook, and X.
        </p>
      </div>
      <select
        id={id}
        title="Delay before automated replies across all connected accounts"
        className="scheduler-select min-w-32 rounded-lg border border-border bg-background py-2 pl-3 pr-9 text-sm"
        value={query.data?.delaySeconds ?? 60}
        disabled={!query.data || mutation.isPending}
        onChange={(event) =>
          mutation.mutate({
            delaySeconds: Number(event.target.value) as z.infer<typeof autoDmDelaySchema>,
            workspaceId: workspaceId!,
          })
        }
      >
        {AUTO_DM_DELAYS.map((seconds) => (
          <option key={seconds} value={seconds}>
            {seconds === 30 ? "30 seconds" : `${seconds / 60} minute${seconds > 60 ? "s" : ""}`}
            {seconds === 60 ? " (default)" : ""}
          </option>
        ))}
      </select>
      {query.isError && (
        <p role="alert" className="w-full text-xs text-destructive">
          Could not load your delay.{" "}
          <button type="button" className="underline" onClick={() => void query.refetch()}>
            Retry
          </button>
        </p>
      )}
    </div>
  );
}
