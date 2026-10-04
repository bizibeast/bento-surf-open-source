import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { useTheme } from "next-themes";
import { Check, ChevronDown, CreditCard, LogOut, Moon, Plus, Settings, Sun } from "lucide-react";
import { DecodedImage } from "@/components/DecodedImage";
import { AddWorkspaceDialog } from "@/components/AddWorkspaceDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { supabase } from "@/integrations/supabase/client";
import { safeMediaUrl } from "@/lib/safe-url";
import type { WorkspaceSession, WorkspaceSummary } from "@/lib/workspace-session.server";
import { switchWorkspace, updateAccountPreference } from "@/lib/workspace.functions";

function WorkspaceAvatar({ workspace }: { workspace: WorkspaceSummary }) {
  const avatarUrl = safeMediaUrl(workspace.avatarUrl);
  return avatarUrl ? (
    <DecodedImage src={avatarUrl} alt="" className="size-8 shrink-0 rounded-lg object-cover" />
  ) : (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent font-ui-display text-sm text-foreground">
      {workspace.displayName.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function WorkspaceMenu({
  session,
  collapsed,
  fallbackProfile,
}: {
  session: WorkspaceSession | null | undefined;
  collapsed: boolean;
  fallbackProfile?: {
    display_name?: string | null;
    username?: string | null;
    avatar_url?: string | null;
  } | null;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { setTheme } = useTheme();
  const [addOpen, setAddOpen] = useState(false);
  const workspace =
    session?.workspace ??
    (fallbackProfile
      ? {
          id: "loading",
          displayName:
            fallbackProfile.display_name?.trim() || fallbackProfile.username || "Your profile",
          username: fallbackProfile.username ?? null,
          avatarUrl: fallbackProfile.avatar_url ?? null,
          status: "active" as const,
          plan: "free" as const,
        }
      : null);

  const selectWorkspace = async (workspaceId: string) => {
    if (workspaceId === session?.workspaceId) return;
    await switchWorkspace({ data: { workspaceId } });
    await queryClient.cancelQueries();
    queryClient.clear();
    await router.invalidate();
  };

  const toggleTheme = async () => {
    const appTheme = session?.appTheme === "dark" ? "light" : "dark";
    await updateAccountPreference({ data: { appTheme } });
    setTheme(appTheme);
    await queryClient.invalidateQueries({ queryKey: ["workspace-session"] });
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    window.location.assign("/");
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Open workspace menu"
            className={`mt-2 flex w-full items-center gap-2 rounded-lg border border-border bg-card p-1.5 text-left hover:bg-accent ${
              collapsed ? "lg:justify-center" : ""
            }`}
          >
            {workspace ? (
              <WorkspaceAvatar workspace={workspace} />
            ) : (
              <span className="size-8 shrink-0 rounded-lg bg-accent" />
            )}
            {!collapsed && (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold text-foreground">
                    {workspace?.displayName ?? "Your profile"}
                  </span>
                  {workspace?.username && (
                    <span className="block truncate text-[10px] text-muted-foreground">
                      @{workspace.username}
                    </span>
                  )}
                </span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              </>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-64 rounded-xl p-1.5">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Bento profiles
          </DropdownMenuLabel>
          {session?.workspaces.map((candidate) => {
            const current = candidate.id === session.workspaceId;
            const disabled = candidate.status !== "active";
            return (
              <DropdownMenuItem
                key={candidate.id}
                disabled={disabled}
                onSelect={() => void selectWorkspace(candidate.id)}
                className="gap-2 rounded-lg"
              >
                <WorkspaceAvatar workspace={candidate} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">
                    {candidate.displayName}
                  </span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {disabled ? "Awaiting payment" : `@${candidate.username ?? "profile"}`}
                  </span>
                </span>
                {current && (
                  <span className="flex items-center gap-1 text-[10px]">
                    <Check className="size-3" />
                    Current
                  </span>
                )}
              </DropdownMenuItem>
            );
          })}
          {!session && <DropdownMenuItem disabled>Loading workspaces…</DropdownMenuItem>}
          <DropdownMenuItem onSelect={() => setAddOpen(true)}>
            <Plus /> Add another profile
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void toggleTheme()} disabled={!session}>
            {session?.appTheme === "dark" ? <Sun /> : <Moon />}
            {session?.appTheme === "dark" ? "Turn light mode on" : "Turn dark mode on"}
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/settings" search={{ section: "plan" }}>
              <CreditCard /> Billing
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/settings">
              <Settings /> Settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void signOut()}>
            <LogOut /> Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AddWorkspaceDialog open={addOpen} onOpenChange={setAddOpen} />
    </>
  );
}
