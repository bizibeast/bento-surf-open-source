import { Check, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { micro } from "@/lib/micro-app-ui";
import { browserTimeZone } from "@/lib/timezones";
import type { PostingSchedule, PostingSlot } from "@/lib/social-scheduler";

const POSTING_DAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
] as const;

type PostingTimeRow = { id: string; time: string; days: number[] };

function postingRows(slots: readonly PostingSlot[]): PostingTimeRow[] {
  const byTime = new Map<string, number[]>();
  for (const slot of slots) byTime.set(slot.time, [...(byTime.get(slot.time) || []), slot.day]);
  const rows = [...byTime.entries()].map(([time, days]) => ({ id: time, time, days }));
  return rows.length ? rows : [{ id: "12:00", time: "12:00", days: [1, 2, 3, 4, 5] }];
}

function postingSlots(rows: readonly PostingTimeRow[]) {
  const unique = new Map<string, PostingSlot>();
  for (const row of rows) {
    for (const day of row.days) unique.set(`${day}:${row.time}`, { day, time: row.time });
  }
  return [...unique.values()].sort((left, right) => left.time.localeCompare(right.time));
}

export function PostingTimesDialog({
  open,
  schedule,
  saving,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  schedule?: PostingSchedule;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (schedule: PostingSchedule) => void;
}) {
  const [rows, setRows] = useState<PostingTimeRow[]>([]);
  const [naturalOffset, setNaturalOffset] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRows(postingRows(schedule?.slots || []));
    setNaturalOffset(Boolean(schedule?.naturalOffset));
  }, [open, schedule]);

  const slotCount = rows.reduce((total, row) => total + row.days.length, 0);

  const addTime = () =>
    setRows((current) => [
      ...current,
      { id: `${Date.now()}`, time: "17:00", days: [1, 2, 3, 4, 5] },
    ]);

  const removeTime = (id: string) => setRows((current) => current.filter((item) => item.id !== id));

  const updateTime = (id: string, time: string) =>
    setRows((current) => current.map((item) => (item.id === id ? { ...item, time } : item)));

  const toggleDay = (id: string, day: number, selected: boolean) =>
    setRows((current) =>
      current.map((item) =>
        item.id === id
          ? {
              ...item,
              days: selected ? item.days.filter((value) => value !== day) : [...item.days, day],
            }
          : item,
      ),
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-4xl overflow-x-hidden overflow-y-auto rounded-[24px] border-black/[0.07] bg-[#f7f8fc] p-0 sm:rounded-[28px]">
        <div className="border-b border-black/[0.06] px-5 py-5 pr-14 sm:px-7">
          <DialogTitle className="font-ui-display text-2xl">Posting times</DialogTitle>
          <DialogDescription className="mt-1 text-sm text-muted-foreground">
            {slotCount} weekly {slotCount === 1 ? "slot" : "slots"} · {schedule?.timezone || "UTC"}
          </DialogDescription>
        </div>

        <div className="space-y-5 px-5 py-5 sm:px-7">
          <div className="space-y-3 sm:hidden" data-posting-times-mobile>
            {rows.map((row, index) => (
              <div key={row.id} className="rounded-2xl border border-black/[0.07] bg-white/70 p-3">
                <div className="flex min-w-0 items-end gap-2">
                  <label className="min-w-0 flex-1">
                    <span className="mb-1.5 block text-xs font-semibold text-muted-foreground">
                      Time {index + 1}
                    </span>
                    <input
                      type="time"
                      value={row.time}
                      onChange={(event) => updateTime(row.id, event.target.value)}
                      className="h-10 w-full min-w-0 rounded-lg border border-black/[0.08] bg-[#f2f5fb] px-3 text-sm font-medium tabular-nums outline-none focus:border-[#17213a]/45"
                    />
                  </label>
                  <button
                    type="button"
                    aria-label={`Remove ${row.time}`}
                    onClick={() => removeTime(row.id)}
                    className="flex size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-rose-50 hover:text-rose-600"
                  >
                    <X className="size-4" />
                  </button>
                </div>
                <div className="mt-3 grid grid-cols-7 gap-1" aria-label={`Days for ${row.time}`}>
                  {POSTING_DAYS.map((day) => {
                    const selected = row.days.includes(day.value);
                    return (
                      <button
                        key={day.value}
                        type="button"
                        aria-label={`${day.label} at ${row.time}`}
                        aria-pressed={selected}
                        onClick={() => toggleDay(row.id, day.value, selected)}
                        className={`flex h-9 min-w-0 items-center justify-center rounded-lg border text-[11px] font-semibold transition-colors ${
                          selected
                            ? "border-[#17213a] bg-[#17213a] text-white"
                            : "border-black/[0.08] bg-[#f7f8fc] text-muted-foreground hover:border-[#17213a]/35"
                        }`}
                      >
                        {day.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={addTime}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-black/[0.07] bg-white/70 px-4 py-3 text-sm font-semibold text-muted-foreground transition-colors hover:bg-white hover:text-foreground"
            >
              <Plus className="size-4" /> Add time
            </button>
          </div>

          <div
            className="hidden overflow-x-auto rounded-2xl border border-black/[0.07] bg-white/70 sm:block"
            data-posting-times-desktop
          >
            <div className="min-w-[760px]">
              <div className="grid grid-cols-[170px_repeat(7,1fr)_42px] items-center border-b border-black/[0.06] px-3 py-2 text-center text-xs font-semibold text-muted-foreground">
                <span className="text-left">Time</span>
                {POSTING_DAYS.map((day) => (
                  <span key={day.value}>{day.label}</span>
                ))}
                <span />
              </div>
              {rows.map((row) => (
                <div
                  key={row.id}
                  className="grid grid-cols-[170px_repeat(7,1fr)_42px] items-center border-b border-black/[0.06] px-3 py-2.5 last:border-b-0"
                >
                  <input
                    type="time"
                    value={row.time}
                    onChange={(event) => updateTime(row.id, event.target.value)}
                    className="w-36 rounded-lg border border-black/[0.08] bg-[#f2f5fb] px-3 py-2 text-sm font-medium tabular-nums outline-none focus:border-[#17213a]/45"
                  />
                  {POSTING_DAYS.map((day) => {
                    const selected = row.days.includes(day.value);
                    return (
                      <button
                        key={day.value}
                        type="button"
                        aria-label={`${day.label} at ${row.time}`}
                        aria-pressed={selected}
                        onClick={() => toggleDay(row.id, day.value, selected)}
                        className={`mx-auto flex size-8 items-center justify-center rounded-lg border transition-colors ${
                          selected
                            ? "border-[#17213a] bg-[#17213a] text-white"
                            : "border-black/[0.08] bg-[#f7f8fc] text-transparent hover:border-[#17213a]/35"
                        }`}
                      >
                        <Check className="size-4" />
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    aria-label={`Remove ${row.time}`}
                    onClick={() => removeTime(row.id)}
                    className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-rose-50 hover:text-rose-600"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={addTime}
                className="flex w-full items-center gap-2 px-4 py-3 text-sm font-semibold text-muted-foreground transition-colors hover:bg-[#f2f5fb] hover:text-foreground"
              >
                <Plus className="size-4" /> Add time
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-2xl bg-[#eef1f6] px-4 py-4">
            <div>
              <p className="text-sm font-semibold text-foreground">Natural posting times</p>
              <p className="mt-1 text-xs text-muted-foreground">Add a small ±4 minute offset.</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={naturalOffset}
              onClick={() => setNaturalOffset((value) => !value)}
              className={`relative h-7 w-12 overflow-hidden rounded-lg transition-colors ${naturalOffset ? "bg-[#17213a]" : "bg-black/10"}`}
            >
              <span
                className={`absolute left-1 top-1 size-5 rounded-[5px] bg-white shadow-sm transition-transform ${naturalOffset ? "translate-x-5" : "translate-x-0"}`}
              />
            </button>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-black/[0.06] bg-white/55 px-5 py-4 sm:px-7">
          <button type="button" onClick={() => onOpenChange(false)} className={micro.btnSoft}>
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() =>
              onSave({
                timezone: schedule?.timezone || browserTimeZone(),
                slots: postingSlots(rows),
                naturalOffset,
              })
            }
            className={micro.btnPrimary}
          >
            {saving ? "Saving…" : "Save posting times"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
