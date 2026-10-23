export function DraftReviewNotice({ notes }: { notes: readonly string[] }) {
  if (!notes.length) return null;
  return (
    <aside
      aria-label="Draft needs review"
      className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950"
    >
      <details>
        <summary className="cursor-pointer font-semibold">Needs review</summary>
        <ul className="mt-2 max-h-40 list-disc space-y-1 overflow-y-auto pl-4">
          {notes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
        <p className="mt-2 text-amber-800">Review this feedback before scheduling.</p>
      </details>
    </aside>
  );
}
