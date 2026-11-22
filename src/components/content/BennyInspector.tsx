import { Brain, CalendarClock, Pencil } from "lucide-react";

export type BennyPanel = "memory" | "schedule";

export function BennyInspector({
  memoryCount,
  scheduleCount,
  onOpen,
}: {
  memoryCount: number;
  scheduleCount: number;
  onOpen: (panel: BennyPanel) => void;
}) {
  const sections = [
    { id: "memory", label: "Memory", icon: Brain, count: memoryCount },
    { id: "schedule", label: "Schedule", icon: CalendarClock, count: scheduleCount },
  ] as const;

  return (
    <div className="benny-inspector">
      {sections.map(({ id, label, icon: Icon, count }) => (
        <div className="benny-inspector-row" key={id}>
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <button type="button" className="benny-inspector-label" onClick={() => onOpen(id)}>
            {label}
            {count > 0 && <span className="benny-inspector-count">{count}</span>}
          </button>
          <button
            type="button"
            className="benny-inspector-edit"
            aria-label={`Edit ${label.toLowerCase()}`}
            title={`Edit ${label.toLowerCase()}`}
            onClick={() => onOpen(id)}
          >
            <Pencil className="size-3.5" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
