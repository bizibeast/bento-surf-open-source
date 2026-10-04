import { useEffect, useRef, useState, type ReactNode } from "react";
import { parsePublicHttpUrl } from "@/lib/safe-url";

function inline(text: string): ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g)
    .map((part, index) => {
      if (part.startsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
      if (part.startsWith("*")) return <em key={index}>{part.slice(1, -1)}</em>;
      if (part.startsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
      const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      if (link && parsePublicHttpUrl(link[2]))
        return (
          <a key={index} href={link[2]} target="_blank" rel="noreferrer noopener">
            {link[1]}
          </a>
        );
      return part;
    });
}

/** A small, safe Markdown subset shared by Brain documents and Agent responses. */
export function ContentMarkdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  const list = (line: string) => line.match(/^\s*([-*•]|\d+[.)])\s+(.+)$/);
  const startsBlock = (line: string) =>
    /^#{1,3} |^```|^> |^[-*]{3}$/.test(line) || Boolean(list(line));
  for (let index = 0; index < lines.length;) {
    const start = index;
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) code.push(lines[index++]);
      index += 1;
      blocks.push(
        <pre key={start}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = line.match(/^(#{1,3}) (.+)$/);
    if (heading) {
      blocks.push(
        heading[1].length === 1 ? (
          <h2 key={start}>{inline(heading[2])}</h2>
        ) : heading[1].length === 2 ? (
          <h3 key={start}>{inline(heading[2])}</h3>
        ) : (
          <h4 key={start}>{inline(heading[2])}</h4>
        ),
      );
      index += 1;
      continue;
    }
    const first = list(line);
    if (first) {
      const ordered = /^\d/.test(first[1]);
      const entries: ReactNode[] = [];
      while (index < lines.length) {
        const entry = list(lines[index]);
        if (!entry || /^\d/.test(entry[1]) !== ordered) break;
        entries.push(<li key={index}>{inline(entry[2])}</li>);
        index += 1;
      }
      blocks.push(ordered ? <ol key={start}>{entries}</ol> : <ul key={start}>{entries}</ul>);
      continue;
    }
    const cells = (value: string) =>
      value
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim());
    if (
      line.includes("|") &&
      lines[index + 1]?.includes("|") &&
      cells(lines[index + 1]).every((cell) => /^:?-+:?$/.test(cell))
    ) {
      const headers = cells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|")) rows.push(cells(lines[index++]));
      blocks.push(
        <div key={start} className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr>
                {headers.map((cell, i) => (
                  <th key={i} className="border-b border-neutral-200 px-3 py-2 font-semibold">
                    {inline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j} className="border-b border-neutral-100 px-3 py-2">
                      {inline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^[-*]{3}$/.test(line.trim())) {
      blocks.push(<hr key={start} className="my-6 border-neutral-200" />);
      index += 1;
      continue;
    }
    if (line.startsWith("> ")) {
      const quotes: string[] = [];
      while (index < lines.length && lines[index].startsWith("> "))
        quotes.push(lines[index++].slice(2));
      blocks.push(
        <blockquote
          key={start}
          className="my-4 border-l-2 border-neutral-300 pl-4 text-neutral-600"
        >
          {inline(quotes.join("\n"))}
        </blockquote>,
      );
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index]))
      paragraph.push(lines[index++]);
    blocks.push(<p key={start}>{inline(paragraph.join("\n"))}</p>);
  }
  return <div className="content-prose">{blocks}</div>;
}

export function ContentDocument({
  label,
  value,
  placeholder,
  onSave,
  initiallyEditing = false,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onSave: (value: string) => void | Promise<void>;
  initiallyEditing?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(initiallyEditing || !value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [undo, setUndo] = useState<string[]>([]);
  const [redo, setRedo] = useState<string[]>([]);
  const input = useRef<HTMLTextAreaElement>(null);
  const dirty = draft !== value;
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const change = (next: string) => {
    setUndo((values) => [...values.slice(-99), draft]);
    setRedo([]);
    setDraft(next);
  };
  const format = (prefix: string, suffix = "") => {
    const element = input.current;
    if (!element) return;
    const { selectionStart: start, selectionEnd: end } = element;
    change(draft.slice(0, start) + prefix + draft.slice(start, end) + suffix + draft.slice(end));
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(start + prefix.length, end + prefix.length);
    });
  };
  const save = async () => {
    if (!draft.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      await onSave(draft.trim());
      setEditing(false);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save. Your edits are still here.",
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="content-document" aria-label={`${label} document`}>
      <div className="content-document-toolbar">
        {editing && (
          <div className="flex gap-1" aria-label="Document formatting">
            <button type="button" aria-label="Heading 1" onClick={() => format("# ")}>
              H₁
            </button>
            <button type="button" aria-label="Heading 2" onClick={() => format("## ")}>
              H₂
            </button>
            <button type="button" aria-label="Bold" onClick={() => format("**", "**")}>
              <strong>B</strong>
            </button>
            <button type="button" aria-label="Italic" onClick={() => format("*", "*")}>
              <em>I</em>
            </button>
            <button type="button" aria-label="Bullet list" onClick={() => format("- ")}>
              ≡
            </button>
            <button
              type="button"
              aria-label="Undo"
              disabled={!undo.length}
              onClick={() => {
                const prior = undo.at(-1);
                if (prior !== undefined) {
                  setRedo((values) => [...values, draft]);
                  setUndo((values) => values.slice(0, -1));
                  setDraft(prior);
                }
              }}
            >
              ↶
            </button>
            <button
              type="button"
              aria-label="Redo"
              disabled={!redo.length}
              onClick={() => {
                const next = redo.at(-1);
                if (next !== undefined) {
                  setUndo((values) => [...values, draft]);
                  setRedo((values) => values.slice(0, -1));
                  setDraft(next);
                }
              }}
            >
              ↷
            </button>
          </div>
        )}
        <div className="ml-auto flex gap-2">
          {editing ? (
            <>
              {!!value && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    setDraft(value);
                    setEditing(false);
                    setError("");
                  }}
                >
                  Cancel
                </button>
              )}
              <button type="button" disabled={!draft.trim() || saving} onClick={() => void save()}>
                {saving ? "Saving…" : "Save"}
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setEditing(true)}>
              Edit {label}
            </button>
          )}
        </div>
      </div>
      {editing ? (
        <textarea
          ref={input}
          aria-label={label}
          value={draft}
          placeholder={placeholder}
          maxLength={20_000}
          onChange={(event) => change(event.target.value)}
          className="content-document-input"
        />
      ) : (
        <ContentMarkdown text={draft} />
      )}
      {editing && (
        <p className="mt-3 text-right text-xs text-neutral-400">
          {draft.length.toLocaleString()} / 20,000{dirty ? " · Unsaved" : ""}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
