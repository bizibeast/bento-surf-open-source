import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { AutoDmMetrics } from "./auto-dm-metrics";

export async function loadAutoDmMetrics(
  userId: string,
  provider: "instagram" | "facebook" | "twitter",
) {
  const { data, error } = await supabaseAdmin.rpc(
    "auto_dm_dashboard_metrics" as never,
    { p_user_id: userId, p_provider: provider } as never,
  );
  if (error) {
    console.error("Auto-DM metrics could not load", { provider, code: error.code });
    return new Map<string, AutoDmMetrics>();
  }
  return new Map(
    ((data as unknown as Array<AutoDmMetrics & { automation_id: string }>) || []).map((row) => [
      row.automation_id,
      row,
    ]),
  );
}
