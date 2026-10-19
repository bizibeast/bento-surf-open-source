import { useEffect, useRef, useState, type ReactNode } from "react";
import { Eye, PencilLine } from "lucide-react";
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

/** Preserve the rendered document structure when an inline edit is saved. */
export function documentMarkdown(element: HTMLElement): string {
  const read = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent || "";
    if (!(node instanceof HTMLElement)) return "";
    const content = Array.from(node.childNodes).map(read).join("");
    switch (node.tagName) {
      case "H2":
        return `\n# ${content}\n\n`;
      case "H3":
        return `\n## ${content}\n\n`;
      case "H4":
        return `\n### ${content}\n\n`;
      case "STRONG":
      case "B":
        return `**${content}**`;
      case "EM":
      case "I":
        return `*${content}*`;
      case "BR":
        return "\n";
      case "A":
        return parsePublicHttpUrl(node.getAttribute("href") || "")
          ? `[${content}](${node.getAttribute("href")})`
          : content;
      case "PRE":
        return `\n\n\`\`\`\n${node.textContent || ""}\n\`\`\`\n\n`;
      case "CODE":
        return `\`${content}\``;
      case "LI":
        return `${node.parentElement?.tagName === "OL" ? `${Array.from(node.parentElement.children).indexOf(node) + 1}.` : "-"} ${content.trim()}\n`;
      case "UL":
      case "OL":
        return `\n${content}\n`;
      case "BLOCKQUOTE":
        return `\n${content
          .trim()
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}\n\n`;
      case "HR":
        return "\n---\n\n";
      case "TABLE": {
        const rows = Array.from(node.querySelectorAll("tr")).map(
          (row) =>
            `| ${Array.from(row.children)
              .map((cell) => read(cell).trim())
              .join(" | ")} |`,
        );
        if (rows.length)
          rows.splice(
            1,
            0,
            `| ${Array.from(node.querySelector("tr")!.children)
              .map(() => "---")
              .join(" | ")} |`,
          );
        return `\n${rows.join("\n")}\n\n`;
      }
      case "P":
      case "DIV":
        return `${content}\n\n`;
      default:
        return content;
    }
  };
  return Array.from(element.childNodes)
    .map(read)
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function ContentDocument({
  label,
  value,
  placeholder,
  onSave,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onSave: (value: string) => void | Promise<void>;
  initiallyEditing?: boolean;
}) {
  const [display, setDisplay] = useState(value);
  const [draft, setDraft] = useState(value);
  const [preview, setPreview] = useState(false);
  const [status, setStatus] = useState("Saved");
  const [error, setError] = useState("");
  const input = useRef<HTMLDivElement>(null);
  const latest = useRef(value);
  const saved = useRef(value);
  const saving = useRef(false);
  const saveHandler = useRef(onSave);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  saveHandler.current = onSave;

  const save = async () => {
    clearTimeout(timer.current);
    if (saving.current || latest.current === saved.current) return;
    const text = latest.current;
    if (!text.trim() || text.length > 20_000) {
      if (mounted.current)
        setError(
          !text.trim()
            ? "Add some text, or delete this item to remove it."
            : "Keep this document under 20,000 characters.",
        );
      return;
    }
    saving.current = true;
    if (mounted.current) {
      setStatus("Saving…");
      setError("");
    }
    try {
      await saveHandler.current(text);
      saved.current = text;
      if (mounted.current) setStatus("Saved");
    } catch (cause) {
      if (mounted.current) {
        setStatus("Not saved");
        setError(
          cause instanceof Error ? cause.message : "Could not save. Your edits are still here.",
        );
      }
      return;
    } finally {
      saving.current = false;
    }
    // Edits made while a request was running must follow it, never race it.
    if (latest.current !== saved.current) await save();
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    // Refetches must not replace text the creator is still typing.
    if (latest.current === saved.current && document.activeElement !== input.current) {
      latest.current = saved.current = value;
      setDisplay(value);
      setDraft(value);
    }
  }, [value]);
  useEffect(() => {
    mounted.current = true;
    const warn = (event: BeforeUnloadEvent) => {
      if (latest.current !== saved.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      window.removeEventListener("beforeunload", warn);
      void saveRef.current();
    };
  }, []);
  const changed = () => {
    if (!input.current) return;
    const next = documentMarkdown(input.current);
    latest.current = next;
    setDraft(next);
    setError("");
    setStatus(next === saved.current ? "Saved" : "Unsaved changes");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveRef.current(), 700);
  };
  const format = (command: string, argument?: string) => {
    input.current?.focus();
    document.execCommand(command, false, argument);
    changed();
  };
  return (
    <section className="content-document" aria-label={`${label} document`}>
      <div className="content-document-toolbar">
        <button
          type="button"
          aria-label={`Edit ${label}`}
          onClick={() => {
            setPreview(false);
            requestAnimationFrame(() => input.current?.focus());
          }}
        >
          Edit
        </button>
        {!preview && (
          <div className="flex gap-1" aria-label="Document formatting">
            <button
              type="button"
              aria-label="Heading 1"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => format("formatBlock", "h2")}
            >
              H₁
            </button>
            <button
              type="button"
              aria-label="Heading 2"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => format("formatBlock", "h3")}
            >
              H₂
            </button>
            <button
              type="button"
              aria-label="Bold"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => format("bold")}
            >
              <strong>B</strong>
            </button>
            <button
              type="button"
              aria-label="Italic"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => format("italic")}
            >
              <em>I</em>
            </button>
            <button
              type="button"
              aria-label="Bullet list"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => format("insertUnorderedList")}
            >
              List
            </button>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          <span role="status" aria-live="polite">
            {status}
          </span>
          <button
            type="button"
            aria-label={preview ? `Write ${label}` : `Preview ${label}`}
            aria-pressed={preview}
            onClick={() => {
              void saveRef.current();
              setDisplay(latest.current);
              setPreview(!preview);
            }}
          >
            {preview ? <PencilLine className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </div>
      <div
        ref={input}
        role="textbox"
        aria-label={label}
        aria-multiline="true"
        aria-readonly={preview}
        contentEditable={!preview}
        suppressContentEditableWarning
        tabIndex={0}
        data-placeholder={placeholder || "Click here and start writing…"}
        data-empty={!draft.trim()}
        className="content-document-editor"
        onInput={changed}
        onBlur={() => void saveRef.current()}
        onDrop={(event) => {
          event.preventDefault();
          document.execCommand("insertText", false, event.dataTransfer.getData("text/plain"));
          changed();
        }}
        onPaste={(event) => {
          event.preventDefault();
          document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
          changed();
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "s") {
            event.preventDefault();
            void saveRef.current();
          }
        }}
      >
        <ContentMarkdown text={display} />
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}{" "}
          <button type="button" className="underline" onClick={() => void saveRef.current()}>
            Retry save
          </button>
        </p>
      )}
    </section>
  );
}
