import { useRef } from "react";
import { RetentionCancellationDialog } from "./RetentionCancellationDialog";
import type { MyBillingOverview } from "@/lib/billing.functions";
import { isPaidPlan, type PaidPlanId, type PlanId } from "@/lib/plans";

/**
 * Hosts the cancellation flow for a paid workspace. A trial cancel ends
 * access immediately, so the workspace plan drops to free while the final
 * step is still on screen. The flow stays mounted, with the plan it started
 * on, until the creator dismisses it.
 */
export function CancellationFlowHost({
  open,
  onOpenChange,
  plan,
  billing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plan: PlanId;
  billing: MyBillingOverview | null | undefined;
}) {
  const startedPlan = useRef<PaidPlanId | null>(null);
  if (isPaidPlan(plan)) startedPlan.current = plan;
  const flowPlan = startedPlan.current;
  if (!billing || !flowPlan || (!isPaidPlan(plan) && !open)) return null;
  return (
    <RetentionCancellationDialog
      open={open}
      onOpenChange={onOpenChange}
      plan={flowPlan}
      billing={billing}
    />
  );
}
