import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, HardDrive, Trash2 } from "lucide-react";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { micro } from "@/lib/micro-app-ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type StorageObject = {
  key: string;
  name: string;
  type: string;
  size: number;
  uploaded: string;
  publicUrl: string | null;
};

type StoragePage = {
  objects: StorageObject[];
  usedBytes: number;
  allowedBytes: number;
  cursor: string | null;
};

async function storageToken() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!data.session?.access_token) throw new Error("Please sign in again to manage storage");
  return data.session.access_token;
}

async function getStoragePage(cursor: string | null, signal?: AbortSignal) {
  const token = await storageToken();
  const url = cursor
    ? `/api/storage/manage?cursor=${encodeURIComponent(cursor)}`
    : "/api/storage/manage";
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  const payload = (await response.json().catch(() => null)) as
    (StoragePage & { error?: string }) | null;
  if (!response.ok || !payload) {
    throw new Error(payload?.error || `Storage could not be loaded (${response.status})`);
  }
  return payload;
}

async function deleteStorageObjects(keys: string[]) {
  const token = await storageToken();
  const response = await fetch("/api/storage/manage", {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ keys }),
  });
  const payload = (await response.json().catch(() => null)) as {
    deletedKeys: string[];
    failedKeys: string[];
    freedBytes: number;
    error?: string;
  } | null;
  if (!response.ok || !payload) {
    throw new Error(payload?.error || `Files could not be deleted (${response.status})`);
  }
  return payload;
}

function formatBytes(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1_024;
  let unit = units[0];
  for (let index = 1; value >= 1_024 && index < units.length; index += 1) {
    value /= 1_024;
    unit = units[index];
  }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)} ${unit}`;
}

function fileCount(count: number) {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

export function StorageManager() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<string | null>>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [failureCount, setFailureCount] = useState(0);
  const storage = useQuery({
    queryKey: ["storage-manager", cursor],
    queryFn: ({ signal }) => getStoragePage(cursor, signal),
  });
  const deletion = useMutation({
    mutationFn: deleteStorageObjects,
    onSuccess: async (result) => {
      setConfirmOpen(false);
      setSelected(result.failedKeys);
      setFailureCount(result.failedKeys.length);
      await storage.refetch();
    },
  });
  const data = storage.data;
  const remaining = Math.max(0, (data?.allowedBytes ?? 0) - (data?.usedBytes ?? 0));
  const selectedCount = selected.length;

  if (storage.isLoading) {
    return <div className={`${micro.card} p-8 text-sm text-[#17213a]/55`}>Loading storage…</div>;
  }
  if (storage.isError || !data) {
    return (
      <div className={`${micro.card} p-8 text-center`} role="alert">
        <p className="text-sm font-semibold text-[#17213a]">Storage could not load</p>
        <button
          type="button"
          onClick={() => void storage.refetch()}
          className={`mt-4 ${micro.btnOutline}`}
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className={`${micro.card} p-5 sm:p-6`}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className={`${micro.iconWell} size-11 shrink-0`} aria-hidden="true">
              <HardDrive className="size-5" />
            </span>
            <div>
              <p className="text-sm font-semibold text-[#17213a]">
                {formatBytes(data.usedBytes)} used of {formatBytes(data.allowedBytes)}
              </p>
              <p className="mt-1 text-xs text-[#17213a]/52">{formatBytes(remaining)} remaining</p>
            </div>
          </div>
          <button
            type="button"
            disabled={!selectedCount || deletion.isPending}
            onClick={() => setConfirmOpen(true)}
            className={`${micro.btnOutline} border-rose-200 text-rose-700 disabled:opacity-45`}
          >
            <Trash2 className="size-4" aria-hidden="true" />
            {selectedCount ? `Delete ${fileCount(selectedCount)}` : "Delete selected"}
          </button>
        </div>
        <div
          className="mt-4 h-2 overflow-hidden rounded-full bg-[#17213a]/8"
          role="progressbar"
          aria-label="Storage used"
          aria-valuemin={0}
          aria-valuemax={data.allowedBytes}
          aria-valuenow={Math.min(data.usedBytes, data.allowedBytes)}
        >
          <div
            className="h-full rounded-full bg-[#3478f6]"
            style={{
              width: `${data.allowedBytes ? Math.min(100, (data.usedBytes / data.allowedBytes) * 100) : 0}%`,
            }}
          />
        </div>
      </div>

      {failureCount > 0 && (
        <div
          role="alert"
          className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
        >
          {fileCount(failureCount)} could not be deleted. Select and try again.
        </div>
      )}
      {deletion.isError && (
        <div
          role="alert"
          className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900"
        >
          {deletion.error instanceof Error ? deletion.error.message : "Files could not be deleted"}
        </div>
      )}

      <div className={`${micro.card} overflow-hidden`}>
        {data.objects.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead className="border-b border-black/[0.06] bg-[#f8faff] text-xs text-[#17213a]/52">
                <tr>
                  <th className="w-12 px-4 py-3">
                    <span className="sr-only">Select</span>
                  </th>
                  <th className="px-4 py-3 font-semibold">Name</th>
                  <th className="px-4 py-3 font-semibold">Type</th>
                  <th className="px-4 py-3 font-semibold">Date</th>
                  <th className="px-4 py-3 text-right font-semibold">Size</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/[0.06]">
                {data.objects.map((object) => {
                  const checked = selected.includes(object.key);
                  return (
                    <tr key={object.key}>
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          aria-label={`Select ${object.name}`}
                          checked={checked}
                          onChange={() =>
                            setSelected((current) =>
                              checked
                                ? current.filter((key) => key !== object.key)
                                : [...current, object.key],
                            )
                          }
                          className="size-4 rounded border-black/20 accent-[#3478f6]"
                        />
                      </td>
                      <td className="max-w-xs truncate px-4 py-3 font-medium text-[#17213a]">
                        {object.name}
                      </td>
                      <td className="px-4 py-3 text-[#17213a]/55">{object.type}</td>
                      <td className="px-4 py-3 text-[#17213a]/55">
                        {new Intl.DateTimeFormat(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        }).format(new Date(object.uploaded))}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-[#17213a]/55">
                        {formatBytes(object.size)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-10 text-center text-sm text-[#17213a]/55">
            No stored files on this page.
          </div>
        )}
        <div className="flex items-center justify-between border-t border-black/[0.06] px-4 py-3">
          <button
            type="button"
            disabled={!history.length}
            aria-label="Previous page"
            onClick={() => {
              const previous = history.at(-1) ?? null;
              setHistory((current) => current.slice(0, -1));
              setCursor(previous);
              setSelected([]);
            }}
            className={`${micro.btnOutline} disabled:opacity-40`}
          >
            <ChevronLeft className="size-4" aria-hidden="true" /> Previous
          </button>
          <button
            type="button"
            disabled={!data.cursor}
            aria-label="Next page"
            onClick={() => {
              setHistory((current) => [...current, cursor]);
              setCursor(data.cursor);
              setSelected([]);
            }}
            className={`${micro.btnOutline} disabled:opacity-40`}
          >
            Next <ChevronRight className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {fileCount(selectedCount)}?</DialogTitle>
            <DialogDescription>
              Files disappear everywhere they are currently used. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              className={micro.btnOutline}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={deletion.isPending}
              onClick={() => deletion.mutate(selected)}
              className="inline-flex items-center justify-center rounded-xl bg-rose-700 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {deletion.isPending ? "Deleting…" : "Delete permanently"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
