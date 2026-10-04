import { useState, type ComponentProps } from "react";
import { AutoDmFlow, AutoDmMetrics } from "@/components/AutoDmDetails";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { micro } from "@/lib/micro-app-ui";

export type AutoDmDetailView = "stats" | "flow" | null;
type Automation = ComponentProps<typeof AutoDmMetrics>["automation"];

export function AutoDmDetailDialog({
  automation,
  view,
  onOpenChange,
}: {
  automation: Automation;
  view: AutoDmDetailView;
  onOpenChange: (view: AutoDmDetailView) => void;
}) {
  const stats = view === "stats";
  return (
    <Dialog open={view !== null} onOpenChange={(open) => !open && onOpenChange(null)}>
      <DialogContent className="max-h-[min(90dvh,760px)] max-w-xl overflow-y-auto">
        <DialogHeader className="pr-8">
          <DialogTitle>{stats ? "Automation stats" : "Automation flow"}</DialogTitle>
          <DialogDescription>{automation.name}</DialogDescription>
        </DialogHeader>
        {stats ? <AutoDmMetrics automation={automation} /> : <AutoDmFlow automation={automation} />}
      </DialogContent>
    </Dialog>
  );
}

export function AutoDmDetailActions({ automation }: { automation: Automation }) {
  const [view, setView] = useState<AutoDmDetailView>(null);
  return (
    <>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={micro.btnOutline} onClick={() => setView("stats")}>
          View Stats
        </button>
        <button type="button" className={micro.btnOutline} onClick={() => setView("flow")}>
          View Automation Flow
        </button>
      </div>
      <AutoDmDetailDialog automation={automation} view={view} onOpenChange={setView} />
    </>
  );
}
