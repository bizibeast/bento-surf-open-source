import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { micro } from "@/lib/micro-app-ui";
import {
  settingsIntegrationsSearch,
  type SettingsIntegrationTarget,
} from "@/lib/settings-integrations";

export function SettingsIntegrationsLink({
  integration,
  children,
  className,
  compact = false,
  icon,
}: {
  integration: SettingsIntegrationTarget;
  children: ReactNode;
  className?: string;
  compact?: boolean;
  icon?: ReactNode;
}) {
  return (
    <Link
      to="/settings"
      search={settingsIntegrationsSearch(integration)}
      className={className || (compact ? micro.btnPrimaryCompact : micro.btnPrimary)}
    >
      {icon === undefined ? <Plus className="size-4" /> : icon}
      {children}
    </Link>
  );
}
