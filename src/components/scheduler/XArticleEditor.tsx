import { ChevronDown, ChevronUp, ImagePlus, Link2, Plus, Trash2 } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { SiX as SiXLogo } from "react-icons/si";
import { PreviewAvatar } from "./ProviderPostPreview";
import { xArticlePostId, type XArticleBlock, type XArticleDocument } from "@/lib/x-account";
import type { SchedulerConnection, SchedulerMedia } from "@/lib/social-scheduler";

const textBlock = (
  text = "",
  type: Extract<XArticleBlock, { kind: "text" }>["type"] = "unstyled",
): XArticleBlock => ({ kind: "text", type, text });

function displayedText(text: string): ReactNode[] {
  const result: ReactNode[] = [];
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let from = 0;
  for (const match of text.matchAll(pattern)) {
    const offset = match.index ?? 0;
    result.push(text.slice(from, offset));
    if (match[1])
      result.push(
        <a
          key={offset}
          href={match[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#1d9bf0] underline"
        >
          {match[1]}
        </a>,
      );
    else if (match[3]) result.push(<strong key={offset}>{match[3]}</strong>);
    else result.push(<em key={offset}>{match[4]}</em>);
    from = offset + match[0].length;
  }
  result.push(text.slice(from));
  return result;
}

export function XArticleEditor({
  article,
  onChange,
  uploadImage,
  uploading,
}: {
  article: XArticleDocument;
  onChange: (value: XArticleDocument) => void;
  uploadImage: (file: File) => Promise<SchedulerMedia | null>;
  uploading: boolean;
}) {
  const coverRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const textRefs = useRef<Record<number, HTMLTextAreaElement | null>>({});
  const update = (index: number, block: XArticleBlock) =>
    onChange({ ...article, blocks: article.blocks.map((item, i) => (i === index ? block : item)) });
  const insert = (block: XArticleBlock) =>
    onChange({ ...article, blocks: [...article.blocks, block] });
  const format = (
    index: number,
    block: Extract<XArticleBlock, { kind: "text" }>,
    kind: "bold" | "italic" | "link",
  ) => {
    const field = textRefs.current[index];
    const start = field?.selectionStart ?? block.text.length;
    const end = field?.selectionEnd ?? block.text.length;
    const selected = block.text.slice(start, end) || (kind === "link" ? "link text" : "text");
    const replacement =
      kind === "bold"
        ? `**${selected}**`
        : kind === "italic"
          ? `*${selected}*`
          : `[${selected}](https://example.com)`;
    update(index, {
      ...block,
      text: block.text.slice(0, start) + replacement + block.text.slice(end),
    });
  };
  const onImage = async (file: File | undefined, cover: boolean) => {
    if (!file) return;
    const uploaded = await uploadImage(file);
    if (!uploaded) return;
    if (cover) onChange({ ...article, cover: uploaded });
    else insert({ kind: "image", media: uploaded });
  };
  return (
    <div className="mt-5 space-y-4" aria-label="X Article editor">
      <div className="rounded-2xl border border-border/70 bg-white p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Cover image</p>
            <p className="text-xs text-muted-foreground">
              Shown above the Article title on X. JPEG, PNG, or WebP, up to 5 MB.
            </p>
          </div>
          <button
            type="button"
            className="rounded-xl border px-3 py-2 text-xs font-semibold"
            disabled={uploading}
            onClick={() => coverRef.current?.click()}
          >
            {article.cover ? "Replace cover" : "Add cover"}
          </button>
        </div>
        <input
          ref={coverRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          aria-label="Upload Article cover"
          onChange={(event) => {
            void onImage(event.target.files?.[0], true);
            event.target.value = "";
          }}
        />
        {article.cover && (
          <div className="mt-3">
            <img
              src={article.cover.url}
              alt="Article cover"
              className="max-h-52 w-full rounded-xl object-cover"
            />
            <button
              type="button"
              onClick={() => onChange({ ...article, cover: null })}
              className="mt-2 text-xs text-muted-foreground underline"
            >
              Remove cover
            </button>
          </div>
        )}
      </div>
      <div className="space-y-3">
        {article.blocks.map((block, index) => (
          <div key={index} className="rounded-2xl border border-border/70 bg-white p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="mr-auto text-xs font-semibold text-muted-foreground">
                {block.kind === "text"
                  ? "Text section"
                  : block.kind === "image"
                    ? "Inline image"
                    : "Embedded X post"}
              </span>
              <button
                type="button"
                aria-label={`Move section ${index + 1} up`}
                disabled={index === 0}
                onClick={() => {
                  const blocks = [...article.blocks];
                  [blocks[index - 1], blocks[index]] = [blocks[index], blocks[index - 1]];
                  onChange({ ...article, blocks });
                }}
              >
                <ChevronUp className="size-4" />
              </button>
              <button
                type="button"
                aria-label={`Move section ${index + 1} down`}
                disabled={index === article.blocks.length - 1}
                onClick={() => {
                  const blocks = [...article.blocks];
                  [blocks[index + 1], blocks[index]] = [blocks[index], blocks[index + 1]];
                  onChange({ ...article, blocks });
                }}
              >
                <ChevronDown className="size-4" />
              </button>
              <button
                type="button"
                aria-label={`Remove section ${index + 1}`}
                onClick={() =>
                  onChange({ ...article, blocks: article.blocks.filter((_, i) => i !== index) })
                }
              >
                <Trash2 className="size-4" />
              </button>
            </div>
            {block.kind === "text" ? (
              <>
                <select
                  aria-label={`Section ${index + 1} style`}
                  value={block.type}
                  onChange={(event) =>
                    update(index, { ...block, type: event.target.value as typeof block.type })
                  }
                  className="rounded-lg border px-2 py-1 text-xs"
                >
                  <option value="unstyled">Paragraph</option>
                  <option value="header-two">Heading</option>
                  <option value="header-three">Subheading</option>
                  <option value="unordered-list-item">Bullet</option>
                  <option value="ordered-list-item">Numbered item</option>
                  <option value="blockquote">Quote</option>
                </select>
                <div className="mt-2 flex gap-2" aria-label={`Section ${index + 1} formatting`}>
                  <button
                    type="button"
                    className="rounded-lg border px-2 py-1 text-xs font-bold"
                    onClick={() => format(index, block, "bold")}
                  >
                    Bold
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border px-2 py-1 text-xs italic"
                    onClick={() => format(index, block, "italic")}
                  >
                    Italic
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border px-2 py-1 text-xs"
                    onClick={() => format(index, block, "link")}
                  >
                    Link
                  </button>
                </div>
                <textarea
                  ref={(node) => {
                    textRefs.current[index] = node;
                  }}
                  aria-label={index === 0 ? "Article body" : `Article section ${index + 1}`}
                  value={block.text}
                  onChange={(event) => update(index, { ...block, text: event.target.value })}
                  rows={Math.max(3, Math.min(10, block.text.split("\n").length + 2))}
                  placeholder="Write your X Article"
                  className="mt-2 w-full resize-y rounded-xl border border-border/60 p-3 text-base outline-none focus:border-[#1d9bf0]"
                />
                <p className="text-[11px] text-muted-foreground">
                  Use **bold**, *italic*, or [link text](https://example.com). @mentions remain in
                  the text.
                </p>
              </>
            ) : block.kind === "image" ? (
              <img
                src={block.media.url}
                alt={block.media.name || "Article image"}
                className="max-h-72 w-full rounded-xl object-contain"
              />
            ) : (
              <>
                <input
                  aria-label={`X post URL for section ${index + 1}`}
                  value={block.url}
                  onChange={(event) => update(index, { ...block, url: event.target.value })}
                  placeholder="https://x.com/name/status/123..."
                  className="w-full rounded-xl border p-3 text-sm"
                />
                {block.url && !xArticlePostId(block.url) && (
                  <p className="mt-1 text-xs text-rose-600">Paste a link to an X post.</p>
                )}
              </>
            )}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-xl border px-3 py-2 text-xs font-semibold"
          onClick={() => insert(textBlock())}
        >
          <Plus className="size-4" />
          Text section
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-xl border px-3 py-2 text-xs font-semibold"
          disabled={
            uploading || article.blocks.filter((block) => block.kind === "image").length >= 20
          }
          onClick={() => imageRef.current?.click()}
        >
          <ImagePlus className="size-4" />
          Inline image
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-xl border px-3 py-2 text-xs font-semibold"
          onClick={() => insert({ kind: "post", url: "" })}
        >
          <Link2 className="size-4" />
          Embed X post
        </button>
        <input
          ref={imageRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          aria-label="Upload inline Article image"
          onChange={(event) => {
            void onImage(event.target.files?.[0], false);
            event.target.value = "";
          }}
        />
      </div>
    </div>
  );
}

export function XArticlePreview({
  connection,
  title,
  article,
  onAvatarError,
}: {
  connection: SchedulerConnection;
  title: string;
  article: XArticleDocument;
  onAvatarError?: () => void;
}) {
  return (
    <div
      className="mx-auto max-w-[600px] overflow-hidden rounded-xl border border-[#333639] bg-black text-[#e7e9ea]"
      aria-label="X Article reader preview"
    >
      <div className="flex items-center gap-3 border-b border-[#2f3336] px-4 py-3">
        <span aria-hidden="true">←</span>
        <span className="text-base font-bold">Article</span>
        <SiXLogo className="ml-auto size-4" />
      </div>
      <div className="flex items-center gap-2 px-4 py-3">
        <PreviewAvatar connection={connection} onError={onAvatarError} />
        <div>
          <p className="text-sm font-semibold">{connection.displayName}</p>
          <p className="text-xs text-[#71767b]">@{connection.handle.replace(/^@/, "")}</p>
        </div>
      </div>
      {article.cover && (
        <img
          src={article.cover.url}
          alt="Article cover"
          className="max-h-[340px] w-full object-cover"
        />
      )}
      <article className="px-4 py-5">
        <h3 className="break-words text-2xl font-extrabold leading-tight">
          {title.trim() || "Article title"}
        </h3>
        <div className="my-4 border-y border-[#2f3336] py-2 text-xs text-[#71767b]">
          ♡ &nbsp;&nbsp; ↻ &nbsp;&nbsp; ◉ &nbsp;&nbsp; ▥
        </div>
        <div className="space-y-4">
          {article.blocks.map((block, index) =>
            block.kind === "image" ? (
              <img
                key={index}
                src={block.media.url}
                alt={block.media.name || "Article image"}
                className="w-full rounded-lg object-contain"
              />
            ) : block.kind === "post" ? (
              xArticlePostId(block.url) ? (
                <div key={index} className="overflow-hidden rounded-xl border border-[#2f3336]">
                  <iframe
                    title={`Embedded X post ${index + 1}`}
                    src={`https://platform.twitter.com/embed/Tweet.html?id=${xArticlePostId(block.url)}&dnt=true&theme=dark`}
                    className="min-h-72 w-full bg-black"
                    loading="lazy"
                  />
                </div>
              ) : (
                <p
                  key={index}
                  className="rounded-xl border border-[#2f3336] p-4 text-sm text-[#71767b]"
                >
                  Paste an X post URL to preview the embed.
                </p>
              )
            ) : block.type === "header-two" ? (
              <h4 key={index} className="text-xl font-bold">
                {block.text ? displayedText(block.text) : "Heading"}
              </h4>
            ) : block.type === "header-three" ? (
              <h5 key={index} className="text-lg font-bold">
                {block.text ? displayedText(block.text) : "Subheading"}
              </h5>
            ) : block.type === "unordered-list-item" ? (
              <p
                key={index}
                className="ml-5 list-item list-disc whitespace-pre-wrap text-sm leading-6"
              >
                {displayedText(block.text)}
              </p>
            ) : block.type === "ordered-list-item" ? (
              <p
                key={index}
                className="ml-5 list-item list-decimal whitespace-pre-wrap text-sm leading-6"
              >
                {displayedText(block.text)}
              </p>
            ) : block.type === "blockquote" ? (
              <blockquote
                key={index}
                className="border-l-2 border-[#71767b] pl-3 text-sm italic leading-6"
              >
                {displayedText(block.text)}
              </blockquote>
            ) : (
              <div key={index} className="space-y-3">
                {block.text.split(/\r?\n/).map((line, lineIndex) => (
                  <p
                    key={lineIndex}
                    className="min-h-5 whitespace-pre-wrap break-words text-sm leading-6"
                  >
                    {line ? displayedText(line) : "\u00a0"}
                  </p>
                ))}
              </div>
            ),
          )}
        </div>
      </article>
    </div>
  );
}
