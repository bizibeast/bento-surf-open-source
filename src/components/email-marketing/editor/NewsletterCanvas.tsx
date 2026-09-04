import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronDown,
  ChevronUp,
  Columns2,
  Copy,
  GripVertical,
  Heading1,
  Image,
  List,
  Minus,
  MoveVertical,
  MousePointerClick,
  Package,
  Plus,
  Quote,
  Share2,
  SlidersHorizontal,
  Trash2,
  Type,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  duplicateNewsletterBlock,
  moveNewsletterBlock,
  type NewsletterBlockStyle,
  type NewsletterContentBlock,
  type NewsletterLeafBlock,
} from "@/lib/newsletter";
import type { NewsletterTemplatePresentation } from "@/lib/newsletter-templates";
import {
  newsletterDocumentClassName,
  newsletterHeadingClassName,
  newsletterParagraphClassName,
} from "../newsletter-document-styles";

type Product = { id?: string; title: string };
type BlockType =
  | "heading"
  | "paragraph"
  | "image"
  | "button"
  | "divider"
  | "product"
  | "social"
  | "quote"
  | "list"
  | "spacer"
  | "section";

const blockOptions: Array<{ type: BlockType; label: string; icon: typeof Type }> = [
  { type: "paragraph", label: "Text", icon: Type },
  { type: "heading", label: "Heading", icon: Heading1 },
  { type: "image", label: "Image", icon: Image },
  { type: "button", label: "Button", icon: MousePointerClick },
  { type: "quote", label: "Quote", icon: Quote },
  { type: "list", label: "List", icon: List },
  { type: "section", label: "Two columns", icon: Columns2 },
  { type: "divider", label: "Divider", icon: Minus },
  { type: "spacer", label: "Spacer", icon: MoveVertical },
  { type: "product", label: "Product", icon: Package },
  { type: "social", label: "Social link", icon: Share2 },
];

function newBlock(type: BlockType, products: Product[]): NewsletterContentBlock {
  const id = crypto.randomUUID();
  switch (type) {
    case "heading":
    case "paragraph":
      return { id, type, text: "" };
    case "image":
      return { id, type, url: "/branding/bento-logo.png", alt: "" };
    case "button":
      return { id, type, label: "Read more", url: "/" };
    case "social":
      return { id, type, label: "Follow along", url: "/" };
    case "divider":
      return { id, type };
    case "product":
      return { id, type, productId: products[0]?.id ?? "" };
    case "quote":
      return { id, type, text: "", attribution: "" };
    case "list":
      return { id, type, items: ["First item", "Second item"] };
    case "spacer":
      return { id, type, height: 24 };
    case "section":
      return {
        id,
        type,
        layout: "two-equal",
        columns: [
          [{ id: crypto.randomUUID(), type: "paragraph", text: "Left column" }],
          [{ id: crypto.randomUUID(), type: "paragraph", text: "Right column" }],
        ],
      };
  }
}

function BlockMenu({
  label,
  onAdd,
  open,
  onOpenChange,
}: {
  label: string;
  onAdd: (type: BlockType) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="inline-flex min-h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-xl border border-black/[0.08] bg-white px-3 text-xs font-semibold text-[#17213a] shadow-sm outline-none hover:bg-[#f6f7f9] focus-visible:ring-2 focus-visible:ring-[#3478f6]/30"
        >
          <Plus className="size-4" />
          {label === "Add content" ? "Add content" : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        aria-label="Block menu"
        align="start"
        className="grid w-56 grid-cols-1 gap-0.5 rounded-xl p-1.5"
      >
        {blockOptions.map((option) => (
          <DropdownMenuItem
            key={option.type}
            aria-label={"Add " + option.type}
            onSelect={() => onAdd(option.type)}
            className="min-h-10 rounded-lg"
          >
            <option.icon className="size-4" />
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LeafEditor({
  block,
  index,
  onChange,
  products,
  onSlash,
  presentation,
}: {
  block: NewsletterLeafBlock;
  index: number;
  onChange: (block: NewsletterLeafBlock) => void;
  products: Product[];
  onSlash?: () => void;
  presentation?: NewsletterTemplatePresentation;
}) {
  const textAreaClass =
    "block min-h-[1.5em] w-full resize-none overflow-hidden border-0 bg-transparent p-0 [field-sizing:content] outline-none placeholder:text-[#17213a]/24 focus:ring-0";
  switch (block.type) {
    case "heading":
    case "paragraph":
      return (
        <textarea
          aria-label={(block.type === "heading" ? "Heading" : "Paragraph") + " text " + index}
          value={block.text}
          rows={1}
          placeholder={block.type === "heading" ? "Write a headline" : "Start writing…"}
          onChange={(event) => onChange({ ...block, text: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "/" && !block.text) {
              event.preventDefault();
              onSlash?.();
            }
          }}
          className={
            textAreaClass +
            (block.type === "heading"
              ? ` ${newsletterHeadingClassName(presentation)} leading-normal`
              : ` ${newsletterParagraphClassName}`)
          }
          style={block.type === "heading" ? { color: presentation?.accentColor } : undefined}
        />
      );
    case "image":
      return block.url ? (
        <img src={block.url} alt={block.alt} className="h-auto w-full rounded-xl" />
      ) : (
        <div className="flex min-h-40 items-center justify-center rounded-xl bg-[#eef0f4] text-sm text-[#17213a]/45">
          Choose an image in the style panel
        </div>
      );
    case "button":
      return (
        <span
          className="inline-flex rounded-xl px-4 py-2.5 text-sm font-semibold text-white"
          style={{ backgroundColor: presentation?.accentColor ?? "#3478f6" }}
        >
          {block.label || "Button"}
        </span>
      );
    case "social":
      return (
        <span
          className="text-sm font-semibold underline underline-offset-4"
          style={{ color: presentation?.accentColor ?? "#3478f6" }}
        >
          {block.label || "Social link"}
        </span>
      );
    case "divider":
      return <hr className="border-black/[0.12]" />;
    case "product": {
      const product = products.find((candidate) => candidate.id === block.productId);
      return (
        <div className="rounded-xl border border-black/[0.08] p-4">
          <p className="text-sm font-semibold">{product?.title ?? "Choose a product"}</p>
          <p className="mt-1 text-xs text-[#17213a]/45">Product card</p>
        </div>
      );
    }
    case "quote":
      return (
        <textarea
          aria-label={"Quote text " + index}
          value={block.text}
          rows={3}
          placeholder="A memorable line…"
          onChange={(event) => onChange({ ...block, text: event.target.value })}
          className={textAreaClass + " border-l-4 pl-5 font-ui-display text-xl leading-8"}
          style={{ borderColor: presentation?.accentColor ?? "#3478f6" }}
        />
      );
    case "list":
      return (
        <textarea
          aria-label={"List items " + index}
          value={block.items.join("\n")}
          rows={Math.max(3, block.items.length)}
          onChange={(event) =>
            onChange({
              ...block,
              items: event.target.value.split("\n").filter((item) => item.trim().length > 0),
            })
          }
          className={textAreaClass + " pl-5 text-sm leading-6"}
        />
      );
    case "spacer":
      return (
        <div
          aria-label={"Spacer " + index}
          className="rounded-lg bg-black/[0.015]"
          style={{ height: block.height }}
        />
      );
  }
}

function visualStyle(style?: NewsletterBlockStyle) {
  return {
    backgroundColor: style?.backgroundColor,
    color: style?.color,
    padding: style?.padding,
    textAlign: style?.textAlign,
    borderRadius: style?.borderRadius,
    borderColor: style?.borderColor,
    borderWidth: style?.borderWidth,
    borderStyle: style?.borderWidth ? ("solid" as const) : undefined,
    fontSize: style?.fontSize,
    fontWeight: style?.fontWeight,
  };
}

function SortableBlock({
  block,
  index,
  count,
  selected,
  onSelect,
  onChange,
  onMove,
  onDuplicate,
  onRemove,
  onInsert,
  onOpenInsert,
  insertOpen,
  products,
  presentation,
}: {
  block: NewsletterContentBlock;
  index: number;
  count: number;
  selected: boolean;
  onSelect: () => void;
  onChange: (block: NewsletterContentBlock) => void;
  onMove: (direction: -1 | 1) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onInsert: (type: BlockType) => void;
  onOpenInsert: (open: boolean) => void;
  insertOpen: boolean;
  products: Product[];
  presentation?: NewsletterTemplatePresentation;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: block.id,
  });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <article
        data-testid={"newsletter-block-" + block.type}
        onClick={onSelect}
        onFocus={onSelect}
        className={
          "group relative rounded-lg transition-colors " +
          (selected ? "bg-[#3478f6]/[0.025]" : "hover:bg-black/[0.018]") +
          (isDragging ? " z-20 opacity-55" : "")
        }
        style={visualStyle(block.style)}
      >
        <div
          className={
            "absolute -top-9 right-20 z-10 flex flex-row rounded-lg border border-black/[0.08] bg-white p-0.5 shadow-sm transition sm:-left-11 sm:right-auto sm:top-0 sm:flex-col " +
            (selected
              ? "opacity-100"
              : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100")
          }
        >
          <button
            type="button"
            aria-label={"Drag " + block.type + " " + (index + 1)}
            className="flex size-8 cursor-grab items-center justify-center rounded-lg hover:bg-[#f1f2f5] active:cursor-grabbing"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="size-4" />
          </button>
          <button
            type="button"
            aria-label={"Move " + block.type + " " + (index + 1) + " up"}
            disabled={index === 0}
            onClick={(event) => {
              event.stopPropagation();
              onMove(-1);
            }}
            className="flex size-8 items-center justify-center rounded-lg hover:bg-[#f1f2f5] disabled:opacity-25"
          >
            <ChevronUp className="size-4" />
          </button>
          <button
            type="button"
            aria-label={"Move " + block.type + " " + (index + 1) + " down"}
            disabled={index === count - 1}
            onClick={(event) => {
              event.stopPropagation();
              onMove(1);
            }}
            className="flex size-8 items-center justify-center rounded-lg hover:bg-[#f1f2f5] disabled:opacity-25"
          >
            <ChevronDown className="size-4" />
          </button>
        </div>

        <div
          className={
            "absolute -right-1 -top-9 z-10 flex items-center rounded-lg border border-black/[0.08] bg-white p-0.5 shadow-sm transition " +
            (selected
              ? "opacity-100"
              : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100")
          }
        >
          <button
            type="button"
            aria-label={"Duplicate " + block.type + " " + (index + 1)}
            onClick={(event) => {
              event.stopPropagation();
              onDuplicate();
            }}
            className="flex size-8 items-center justify-center rounded-lg hover:bg-[#f1f2f5]"
          >
            <Copy className="size-4" />
          </button>
          <button
            type="button"
            aria-label={"Remove " + block.type + " " + (index + 1)}
            disabled={count === 1}
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
            className="flex size-8 items-center justify-center rounded-lg text-red-500 hover:bg-red-50 disabled:opacity-25"
          >
            <Trash2 className="size-4" />
          </button>
        </div>

        {block.type === "section" ? (
          <div
            className={
              "grid grid-cols-1 gap-5 " +
              (block.layout === "two-left"
                ? "sm:grid-cols-[1.6fr_1fr]"
                : block.layout === "two-right"
                  ? "sm:grid-cols-[1fr_1.6fr]"
                  : "sm:grid-cols-2")
            }
          >
            {block.columns.map((column, columnIndex) => (
              <div key={columnIndex} data-testid="newsletter-editor-column" className="space-y-4">
                {column.map((child, childIndex) => (
                  <LeafEditor
                    key={child.id}
                    block={child}
                    index={childIndex + 1}
                    products={products}
                    presentation={presentation}
                    onChange={(next) =>
                      onChange({
                        ...block,
                        columns: block.columns.map((candidate, candidateIndex) =>
                          candidateIndex === columnIndex
                            ? candidate.map((value, valueIndex) =>
                                valueIndex === childIndex ? next : value,
                              )
                            : candidate,
                        ) as [NewsletterLeafBlock[], NewsletterLeafBlock[]],
                      })
                    }
                  />
                ))}
              </div>
            ))}
          </div>
        ) : (
          <LeafEditor
            block={block}
            index={index + 1}
            products={products}
            presentation={presentation}
            onSlash={() => onOpenInsert(true)}
            onChange={onChange}
          />
        )}
      </article>
      <div className="flex h-6 items-center justify-center opacity-0 transition hover:opacity-100 focus-within:opacity-100">
        <BlockMenu
          label={"Add block after " + (index + 1)}
          onAdd={onInsert}
          open={insertOpen}
          onOpenChange={onOpenInsert}
        />
      </div>
    </div>
  );
}

function StyleInspector({
  block,
  onChange,
  products,
}: {
  block: NewsletterContentBlock;
  onChange: (block: NewsletterContentBlock) => void;
  products: Product[];
}) {
  const updateStyle = (style: Partial<NewsletterBlockStyle>) =>
    onChange({ ...block, style: { ...block.style, ...style } });
  const inputClass =
    "min-h-10 w-full rounded-lg border border-black/[0.08] bg-white px-3 text-sm outline-none focus:border-[#3478f6]/45";
  return (
    <aside
      aria-label="Block style"
      className="rounded-2xl border border-black/[0.07] bg-white p-4 shadow-sm lg:sticky lg:top-24"
    >
      <div className="border-b border-black/[0.07] pb-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#17213a]/38">
          Selected block
        </p>
        <h3 className="mt-1 font-semibold capitalize text-[#17213a]">{block.type}</h3>
      </div>
      <div className="grid gap-4 py-4">
        <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60">
          Block background
          <input
            aria-label="Block background"
            value={block.style?.backgroundColor ?? ""}
            placeholder="#ffffff"
            onChange={(event) => updateStyle({ backgroundColor: event.target.value })}
            className={inputClass}
          />
        </label>
        <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60">
          Alignment
          <select
            value={block.style?.textAlign ?? "left"}
            onChange={(event) =>
              updateStyle({
                textAlign: event.target.value as NewsletterBlockStyle["textAlign"],
              })
            }
            className={inputClass}
          >
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </label>
        <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60">
          Padding
          <input
            type="range"
            min="0"
            max="80"
            value={block.style?.padding ?? 0}
            onChange={(event) => updateStyle({ padding: Number(event.target.value) })}
          />
        </label>
        <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60">
          Show in
          <select
            value={block.visibility ?? "both"}
            onChange={(event) =>
              onChange({
                ...block,
                visibility: event.target.value as NewsletterContentBlock["visibility"],
              })
            }
            className={inputClass}
          >
            <option value="both">Email and web</option>
            <option value="email">Email only</option>
            <option value="web">Web only</option>
          </select>
        </label>
      </div>
      <div className="grid gap-3 border-t border-black/[0.07] pt-4">
        {block.type === "image" ? (
          <>
            <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60">
              Image URL
              <input
                aria-label="Image URL"
                value={block.url}
                onChange={(event) => onChange({ ...block, url: event.target.value })}
                className={inputClass}
              />
            </label>
            <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60">
              Image alt text
              <input
                value={block.alt}
                onChange={(event) => onChange({ ...block, alt: event.target.value })}
                className={inputClass}
              />
            </label>
          </>
        ) : null}
        {block.type === "button" || block.type === "social" ? (
          <>
            <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60">
              Label
              <input
                value={block.label}
                onChange={(event) => onChange({ ...block, label: event.target.value })}
                className={inputClass}
              />
            </label>
            <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60">
              URL
              <input
                value={block.url}
                onChange={(event) => onChange({ ...block, url: event.target.value })}
                className={inputClass}
              />
            </label>
          </>
        ) : null}
        {block.type === "product" ? (
          <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60">
            Product
            <select
              value={block.productId}
              onChange={(event) => onChange({ ...block, productId: event.target.value })}
              className={inputClass}
            >
              <option value="">Choose a published product</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.title}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {block.type === "section" ? (
          <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60">
            Column layout
            <select
              value={block.layout}
              onChange={(event) =>
                onChange({
                  ...block,
                  layout: event.target.value as Extract<
                    NewsletterContentBlock,
                    { type: "section" }
                  >["layout"],
                })
              }
              className={inputClass}
            >
              <option value="two-equal">Equal columns</option>
              <option value="two-left">Wide left</option>
              <option value="two-right">Wide right</option>
            </select>
          </label>
        ) : null}
      </div>
    </aside>
  );
}

export function NewsletterCanvas({
  title,
  onTitleChange,
  publicationName,
  publicationLogoUrl,
  content,
  onChange,
  products,
  presentation,
}: {
  title?: string;
  onTitleChange?: (title: string) => void;
  publicationName?: string;
  publicationLogoUrl?: string | null;
  content: NewsletterContentBlock[];
  onChange: (content: NewsletterContentBlock[]) => void;
  products: Product[];
  presentation?: NewsletterTemplatePresentation;
}) {
  const [selectedId, setSelectedId] = useState(content[0]?.id ?? null);
  const [openAfterIndex, setOpenAfterIndex] = useState<number | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const selectedIndex = content.findIndex((block) => block.id === selectedId);
  const selected = selectedIndex >= 0 ? content[selectedIndex] : null;
  const ids = useMemo(() => content.map((block) => block.id), [content]);

  const replace = (index: number, block: NewsletterContentBlock) =>
    onChange(
      content.map((candidate, candidateIndex) => (candidateIndex === index ? block : candidate)),
    );

  const insert = (index: number, type: BlockType) => {
    const block = newBlock(type, products);
    onChange([...content.slice(0, index), block, ...content.slice(index)]);
    setSelectedId(block.id);
  };

  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return;
    const from = content.findIndex((block) => block.id === event.active.id);
    const to = content.findIndex((block) => block.id === event.over?.id);
    if (from >= 0 && to >= 0) onChange(arrayMove(content, from, to));
  };

  return (
    <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_260px]">
      <div className="min-w-0">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <BlockMenu label="Add content" onAdd={(type) => insert(content.length, type)} />
            {selected ? (
              <Sheet>
                <SheetTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-black/[0.08] bg-white px-3 text-xs font-semibold text-[#17213a] shadow-sm lg:hidden"
                  >
                    <SlidersHorizontal className="size-4" />
                    Style
                  </button>
                </SheetTrigger>
                <SheetContent side="right" className="w-[min(100%,24rem)] bg-[#f5f5f3] pt-12">
                  <SheetHeader className="sr-only">
                    <SheetTitle>Block style</SheetTitle>
                    <SheetDescription>Change the selected newsletter block.</SheetDescription>
                  </SheetHeader>
                  <StyleInspector
                    block={selected}
                    onChange={(next) => replace(selectedIndex, next)}
                    products={products}
                  />
                </SheetContent>
              </Sheet>
            ) : null}
          </div>
          <p className="hidden text-xs text-[#17213a]/38 sm:block">
            Hover a block to drag or edit it.
          </p>
        </div>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <div
              data-testid="newsletter-editor-document"
              data-bento-public-page
              className={newsletterDocumentClassName(presentation)}
              style={{
                maxWidth: presentation?.contentWidth ?? 680,
                backgroundColor: presentation?.backgroundColor ?? "#ffffff",
                overflow: "visible",
              }}
            >
              {onTitleChange ? (
                <div className="mb-7">
                  {publicationName ? (
                    <div className="mb-6 flex items-center gap-3">
                      {publicationLogoUrl ? (
                        <img
                          src={publicationLogoUrl}
                          alt=""
                          className="size-11 rounded-xl object-cover"
                        />
                      ) : null}
                      <span className="text-sm font-semibold">{publicationName}</span>
                    </div>
                  ) : null}
                  <label className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-[#17213a]/38">
                    Post title
                    <input
                      aria-label="Post name"
                      value={title ?? ""}
                      maxLength={120}
                      placeholder="Untitled post"
                      onChange={(event) => onTitleChange(event.target.value)}
                      className={`${presentation?.headingStyle === "sans" ? "font-ui-sans" : "font-ui-display"} mt-2 block w-full bg-transparent text-3xl font-semibold normal-case tracking-normal text-[#17213a] outline-none placeholder:text-[#17213a]/25`}
                    />
                  </label>
                </div>
              ) : null}
              {content.map((block, index) => (
                <SortableBlock
                  key={block.id}
                  block={block}
                  index={index}
                  count={content.length}
                  selected={block.id === selectedId}
                  onSelect={() => setSelectedId(block.id)}
                  onChange={(next) => replace(index, next)}
                  onMove={(direction) =>
                    onChange(moveNewsletterBlock(content, index, index + direction))
                  }
                  onDuplicate={() => onChange(duplicateNewsletterBlock(content, index))}
                  onRemove={() => {
                    const next = content.filter((_, candidateIndex) => candidateIndex !== index);
                    onChange(next);
                    setSelectedId(next[Math.min(index, next.length - 1)]?.id ?? null);
                  }}
                  onInsert={(type) => insert(index + 1, type)}
                  insertOpen={openAfterIndex === index}
                  onOpenInsert={(open) => setOpenAfterIndex(open ? index : null)}
                  products={products}
                  presentation={presentation}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>
      <div className="hidden lg:block">
        {selected ? (
          <StyleInspector
            block={selected}
            onChange={(next) => replace(selectedIndex, next)}
            products={products}
          />
        ) : (
          <aside
            aria-label="Block style"
            className="rounded-2xl border border-dashed border-black/[0.1] p-5 text-sm text-[#17213a]/45"
          >
            Select a section to change its style.
          </aside>
        )}
      </div>
    </div>
  );
}
