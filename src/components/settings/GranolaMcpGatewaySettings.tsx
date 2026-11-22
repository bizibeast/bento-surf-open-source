import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  getGranolaMcpDelegation,
  updateGranolaMcpDelegation,
} from "@/lib/granola-mcp-gateway.functions";

export function GranolaMcpGatewaySettings({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["granola-mcp-delegation", workspaceId];
  const query = useQuery({ queryKey, queryFn: () => getGranolaMcpDelegation(), retry: false });
  const update = useMutation({
    mutationFn: (data: { id: string; enabled: boolean }) => updateGranolaMcpDelegation({ data }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
  if (!query.data?.available) return null;
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-medium">Granola MCP</h3>
      <p className="mt-2 text-sm text-muted-foreground">
        Let your authorized Bento MCP clients read the names and IDs of your selected Granola
        folders.
      </p>
      <Link
        to="/content"
        search={{ tab: "brain", section: "sources" }}
        className="mt-2 inline-block text-sm underline"
      >
        Connect Granola or choose folders in Brain
      </Link>
      <div className="mt-3 grid gap-2">
        {query.data.connections.map((item) => (
          <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>{item.name}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={update.isPending || (!item.enabled && !item.hasSelectedFolders)}
              onClick={() => update.mutate({ id: item.id, enabled: !item.enabled })}
            >
              {item.enabled ? "Revoke folder access" : "Allow folder access"}
            </Button>
          </div>
        ))}
      </div>
      {update.error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {update.error.message}
        </p>
      )}
    </div>
  );
}
