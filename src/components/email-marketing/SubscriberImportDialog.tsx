import type { ReactElement } from "react";
import { useRef, useState } from "react";
import {
  importPublicationSubscribers,
  previewPublicationSubscriberImport,
} from "@/lib/newsletter-import.functions";
import {
  parseSubscriberCsv,
  type SubscriberColumnMapping,
  type SubscriberCsvError,
  type SubscriberImportRow,
} from "@/lib/newsletter-import";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type ImportResult = {
  imported: number;
  updated: number;
  skipped: number;
  invalid: number;
  blocked: number;
};

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-[#3478f6] focus-visible:ring-offset-2";
const structuralErrors = new Set(["malformed_csv", "duplicate_header", "row_limit_exceeded"]);

export function SubscriberImportDialog({
  open,
  onOpenChange,
  publication,
  trigger,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  publication: { id: string; title: string };
  trigger?: ReactElement;
  onImported: () => Promise<void>;
}) {
  const [step, setStep] = useState<"upload" | "map" | "review" | "complete">("upload");
  const [fileName, setFileName] = useState("");
  const [source, setSource] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<SubscriberColumnMapping>({ email: "" });
  const [rows, setRows] = useState<SubscriberImportRow[]>([]);
  const [errors, setErrors] = useState<SubscriberCsvError[]>([]);
  const [batchId, setBatchId] = useState("");
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [fileError, setFileError] = useState("");
  const [result, setResult] = useState<ImportResult>();
  const [preview, setPreview] = useState<{
    existing: number;
    required: number;
    blocked: number;
  }>();
  const [previewPending, setPreviewPending] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const fileGeneration = useRef(0);

  const duplicates = rows.length - new Set(rows.map((row) => row.email)).size;
  const valid = rows.length - duplicates;
  const invalid = errors.length;
  const blocked = preview?.blocked ?? 0;

  const chooseFile = async (file?: File) => {
    const generation = ++fileGeneration.current;
    if (!file) return;
    setFileError("");
    setRequestError("");
    setResult(undefined);
    setPreview(undefined);
    setPreviewError("");
    setConsentConfirmed(false);
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setFileError("Choose a CSV file.");
      return;
    }
    if (file.size > 5_000_000) {
      setFileError("CSV files must be 5 MB or smaller.");
      return;
    }
    try {
      const text = await readFile(file);
      if (generation !== fileGeneration.current) return;
      const parsed = parseSubscriberCsv(text);
      const fatal = parsed.errors.find((error) => structuralErrors.has(error.code));
      setFileName(file.name);
      setSource(text);
      setHeaders(parsed.headers);
      setBatchId(crypto.randomUUID());
      setMapping({
        email: parsed.headers.includes("email") ? "email" : "",
        ...(parsed.headers.includes("name") ? { name: "name" } : {}),
        ...(parsed.headers.includes("list") ? { list: "list" } : {}),
      });
      if (fatal || parsed.headers.length === 0) {
        setFileError(csvErrorMessage(fatal));
        setStep("upload");
        return;
      }
      setStep("map");
    } catch {
      if (generation !== fileGeneration.current) return;
      setFileError("CSV file could not be read. Choose it again.");
      setStep("upload");
    }
  };

  const review = async () => {
    const parsed = parseSubscriberCsv(source, mapping);
    const fatal = parsed.errors.find((error) => structuralErrors.has(error.code));
    if (fatal || parsed.errors.some((error) => error.code === "missing_email_header")) {
      setFileError(csvErrorMessage(fatal ?? parsed.errors[0]));
      return;
    }
    setRows(parsed.rows);
    setErrors(parsed.errors);
    setFileError("");
    setPreviewPending(true);
    setPreviewError("");
    try {
      const preview = await previewPublicationSubscriberImport({
        data: { publicationId: publication.id, rows: parsed.rows },
      });
      setPreview(preview);
      setStep("review");
    } catch (error) {
      setPreviewError(
        error instanceof Error ? error.message : "Capacity preview could not be loaded.",
      );
    } finally {
      setPreviewPending(false);
    }
  };

  const submit = async () => {
    if (!consentConfirmed || !rows.length || !batchId) return;
    setPending(true);
    setRequestError("");
    try {
      const imported = await importPublicationSubscribers({
        data: {
          publicationId: publication.id,
          batchId,
          rows,
          consentConfirmed: true,
        },
      });
      setResult({ ...imported, invalid: imported.invalid + errors.length });
      setStep("complete");
      await onImported().catch(() => undefined);
    } catch (error) {
      setRequestError(
        error instanceof Error ? error.message : "Import failed. It is safe to retry.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      {open && (
        <DialogContent className="max-w-2xl rounded-[28px] p-5 shadow-2xl sm:p-7">
          <div className="flex items-start justify-between gap-4">
            <DialogHeader>
              <DialogTitle className="font-ui-display text-2xl">Import subscribers</DialogTitle>
              <DialogDescription className="mt-1 text-sm text-[#17213a]/50">
                Add subscribers to {publication.title}.
              </DialogDescription>
            </DialogHeader>
          </div>

          <ol
            className="mt-5 grid grid-cols-3 gap-2 text-xs font-semibold"
            aria-label="Import steps"
          >
            {[
              ["upload", "Upload"],
              ["map", "Map"],
              ["review", "Review"],
            ].map(([key, label], index) => {
              const activeIndex =
                step === "complete" ? 3 : ["upload", "map", "review"].indexOf(step);
              return (
                <li
                  key={key}
                  className={`rounded-full px-3 py-2 text-center ${index <= activeIndex ? "bg-[#dceaff] text-[#245fd0]" : "bg-[#f1f4fa] text-[#17213a]/45"}`}
                >
                  {label}
                </li>
              );
            })}
          </ol>

          {step === "upload" && (
            <section className="mt-6">
              <h3 className="font-ui-display text-xl">Upload CSV</h3>
              <p className="mt-1 text-sm text-[#17213a]/50">
                Use a CSV with one header row. The file stays in this browser and is not uploaded to
                storage.
              </p>
              <label className="mt-4 block rounded-2xl border border-dashed border-black/[0.15] bg-[#f8faff] p-5 text-sm font-medium">
                CSV file
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) => void chooseFile(event.target.files?.[0])}
                  className={`mt-3 block w-full text-sm ${focusRing}`}
                />
              </label>
              {fileError && (
                <p
                  className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700"
                  role="alert"
                >
                  {fileError}
                </p>
              )}
            </section>
          )}

          {step === "map" && (
            <section className="mt-6">
              <h3 className="font-ui-display text-xl">Map columns</h3>
              <p className="mt-1 text-sm text-[#17213a]/50">{fileName}</p>
              <div className="mt-4 grid gap-4 sm:grid-cols-3">
                <ColumnSelect
                  label="Email column"
                  value={mapping.email}
                  headers={headers}
                  required
                  onChange={(email) => setMapping((current) => ({ ...current, email }))}
                />
                <ColumnSelect
                  label="Name column"
                  value={mapping.name ?? ""}
                  headers={headers}
                  onChange={(name) =>
                    setMapping((current) => ({ ...current, name: name || undefined }))
                  }
                />
                <ColumnSelect
                  label="List column"
                  value={mapping.list ?? ""}
                  headers={headers}
                  onChange={(list) =>
                    setMapping((current) => ({ ...current, list: list || undefined }))
                  }
                />
              </div>
              {fileError && (
                <p
                  className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700"
                  role="alert"
                >
                  {fileError}
                </p>
              )}
              <div className="mt-5 flex justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setStep("upload")}
                  className={`rounded-xl border border-black/[0.08] px-4 py-2.5 text-xs font-semibold ${focusRing}`}
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => void review()}
                  disabled={!mapping.email || previewPending}
                  className={`rounded-xl bg-[#17213a] px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-45 ${focusRing}`}
                >
                  Review import
                </button>
              </div>
            </section>
          )}

          {step === "review" && (
            <section className="mt-6">
              <h3 className="font-ui-display text-xl">Review import</h3>
              <p className="mt-1 text-sm text-[#17213a]/50">{fileName}</p>
              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
                <Count label="valid" value={valid} />
                <Count label="duplicate" value={duplicates} />
                <Count label="invalid" value={invalid} />
                <Count label="slots required" value={preview?.required ?? 0} />
                <Count label="blocked by capacity" value={blocked} />
              </div>
              {blocked > 0 && (
                <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  Current capacity will block {blocked} required subscriber slots. Already
                  subscribed contacts do not use another slot.
                </p>
              )}
              {previewError && (
                <p className="mt-3 text-sm text-red-700" role="alert">
                  {previewError}
                </p>
              )}
              {invalid > 0 && (
                <p className="mt-3 text-sm text-[#17213a]/55">
                  Invalid rows stay out of the server mutation. Fix the CSV and upload again to
                  include them.
                </p>
              )}
              <label className="mt-5 flex items-start gap-3 rounded-2xl border border-black/[0.08] p-4 text-sm">
                <input
                  type="checkbox"
                  checked={consentConfirmed}
                  onChange={(event) => setConsentConfirmed(event.target.checked)}
                  className={`mt-0.5 size-4 rounded border-black/20 ${focusRing}`}
                />
                I confirm these subscribers consented to receive email from {publication.title}.
              </label>
              {requestError && (
                <p
                  className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700"
                  role="alert"
                >
                  {requestError} Your validated file and batch are retained, so retrying is safe.
                </p>
              )}
              {pending && (
                <div
                  role="progressbar"
                  aria-label="Import progress"
                  aria-valuetext="Importing subscribers"
                  className="mt-4 h-2 overflow-hidden rounded-full bg-[#dceaff]"
                >
                  <div className="h-full w-2/3 animate-pulse rounded-full bg-[#3478f6]" />
                </div>
              )}
              <div className="mt-5 flex justify-between gap-3">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setStep("map")}
                  className={`rounded-xl border border-black/[0.08] px-4 py-2.5 text-xs font-semibold disabled:opacity-45 ${focusRing}`}
                >
                  Back to mapping
                </button>
                <button
                  type="button"
                  disabled={!consentConfirmed || !rows.length || pending}
                  onClick={() => void submit()}
                  className={`rounded-xl bg-[#3478f6] px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-45 ${focusRing}`}
                >
                  {pending ? "Importing…" : requestError ? "Retry import" : "Import subscribers"}
                </button>
              </div>
            </section>
          )}

          {step === "complete" && result && (
            <section className="mt-6">
              <h3 className="font-ui-display text-xl">Import complete</h3>
              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
                <Count label="imported" value={result.imported} />
                <Count label="updated" value={result.updated} />
                <Count label="skipped" value={result.skipped} />
                <Count label="invalid" value={result.invalid} />
                <Count label="blocked by capacity" value={result.blocked} />
              </div>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className={`mt-5 rounded-xl bg-[#17213a] px-4 py-2.5 text-xs font-semibold text-white ${focusRing}`}
              >
                Done
              </button>
            </section>
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}

function ColumnSelect({
  label,
  value,
  headers,
  required,
  onChange,
}: {
  label: string;
  value: string;
  headers: string[];
  required?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="text-xs font-semibold text-[#17213a]/60">
      {label}
      <select
        value={value}
        required={required}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-1 block w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2.5 text-sm text-[#17213a] ${focusRing}`}
      >
        <option value="">{required ? "Choose column" : "Don't import"}</option>
        {headers.map((header) => (
          <option key={header} value={header}>
            {header}
          </option>
        ))}
      </select>
    </label>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  const displayLabel = label === "duplicate" && value !== 1 ? "duplicates" : label;
  return (
    <div className="rounded-2xl bg-[#f6f7fa] p-3 text-center text-sm font-semibold tabular-nums">
      {value} {displayLabel}
    </div>
  );
}

function csvErrorMessage(error?: SubscriberCsvError) {
  if (!error || error.code === "malformed_csv")
    return "CSV could not be parsed. Check its quotes and rows.";
  if (error.code === "row_limit_exceeded") return "CSV can contain at most 10,000 rows.";
  if (error.code === "duplicate_header") return "CSV has duplicate mapped column headers.";
  if (error.code === "missing_email_header")
    return "Choose the column containing subscriber emails.";
  return `CSV row ${error.row} is invalid.`;
}

function readFile(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
