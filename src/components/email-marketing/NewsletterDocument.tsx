import type { CSSProperties } from "react";
import {
  safeNewsletterUrl,
  type NewsletterBlockStyle,
  type NewsletterContentBlock,
  type NewsletterLeafBlock,
} from "@/lib/newsletter";
import type { NewsletterTemplatePresentation } from "@/lib/newsletter-templates";
import {
  newsletterContentClassName,
  newsletterDocumentClassName,
  newsletterHeadingClassName,
  newsletterParagraphClassName,
} from "./newsletter-document-styles";

export type NewsletterDocumentProduct = {
  id?: string;
  title: string;
  description: string;
  url: string;
  priceAmount?: number;
  currency?: string;
  billingInterval?: string | null;
};

type ResolvedProductBlock = {
  id: string;
  type: "product";
  product: Omit<NewsletterDocumentProduct, "id"> | null;
  visibility?: "both" | "email" | "web";
  style?: NewsletterBlockStyle;
};

type RenderableBlock = NewsletterContentBlock | ResolvedProductBlock;

export type NewsletterPaidProduct = {
  title: string;
  url: string;
};

export function NewsletterPaidPost({
  subject,
  previewText,
  paidProduct,
}: {
  subject: string;
  previewText?: string;
  paidProduct?: NewsletterPaidProduct | null;
}) {
  const href = paidProduct ? safeNewsletterUrl(paidProduct.url) : null;
  if (!paidProduct || !href) {
    return (
      <article className="rounded-3xl bg-white p-7 text-center shadow-sm sm:p-10">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#17213a]/42">
          Paid post unavailable
        </p>
        <h1 className="mt-3 font-ui-display text-3xl">{subject}</h1>
        <p className="mx-auto mt-4 max-w-lg leading-7 text-[#17213a]/58">
          This publication needs an active paid offer before this post can be viewed.
        </p>
      </article>
    );
  }

  return (
    <article className="rounded-3xl bg-white p-7 text-center shadow-sm sm:p-10">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#17213a]/42">
        Paid post
      </p>
      <h1 className="mt-3 font-ui-display text-3xl">{subject}</h1>
      {previewText ? (
        <p className="mx-auto mt-4 max-w-lg leading-7 text-[#17213a]/58">{previewText}</p>
      ) : null}
      <a
        href={href}
        className="mt-7 inline-flex rounded-xl bg-[#17213a] px-5 py-3 text-sm font-semibold text-white"
      >
        Subscribe to {paidProduct.title}
      </a>
    </article>
  );
}

function webStyle(style?: NewsletterBlockStyle): CSSProperties {
  if (!style) return {};
  return {
    backgroundColor: style.backgroundColor,
    color: style.color,
    padding: style.padding,
    textAlign: style.textAlign,
    borderRadius: style.borderRadius,
    borderColor: style.borderColor,
    borderWidth: style.borderWidth,
    borderStyle: style.borderWidth ? "solid" : undefined,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
  };
}

function ProductCard({
  product,
  style,
}: {
  product: NewsletterDocumentProduct | null;
  style?: NewsletterBlockStyle;
}) {
  return (
    <div className="rounded-xl border border-black/[0.08] p-4 text-sm" style={webStyle(style)}>
      {product ? (
        <a href={product.url} className="block" target="_blank" rel="noreferrer noopener">
          <strong>{product.title}</strong>
          {product.description ? (
            <span className="mt-1 block text-[#17213a]/55">{product.description}</span>
          ) : null}
          {typeof product.priceAmount === "number" && product.currency ? (
            <span className="mt-2 block font-semibold">
              {new Intl.NumberFormat(undefined, {
                style: "currency",
                currency: product.currency.toUpperCase(),
              }).format(product.priceAmount / 100)}
              {product.billingInterval ? " / " + product.billingInterval : ""}
            </span>
          ) : null}
        </a>
      ) : (
        "Product unavailable"
      )}
    </div>
  );
}

function NewsletterBlocks({
  content,
  products,
  presentation,
}: {
  content: RenderableBlock[];
  products: NewsletterDocumentProduct[];
  presentation?: NewsletterTemplatePresentation;
}) {
  return content.map((block) => {
    if (block.visibility === "email") return null;
    const style = webStyle(block.style);
    switch (block.type) {
      case "heading":
        return (
          <h2
            key={block.id}
            className={newsletterHeadingClassName(presentation)}
            style={{ color: presentation?.accentColor, ...style }}
          >
            {block.text}
          </h2>
        );
      case "paragraph":
        return (
          <p key={block.id} className={newsletterParagraphClassName} style={style}>
            {block.text}
          </p>
        );
      case "image": {
        const src = safeNewsletterUrl(block.url);
        const href = block.href ? safeNewsletterUrl(block.href) : null;
        if (!src) {
          return (
            <p key={block.id} className="rounded-xl bg-[#f6f7fa] p-4 text-sm text-[#17213a]/48">
              {block.alt || "Image unavailable"}
            </p>
          );
        }
        const image = <img src={src} alt={block.alt} className="h-auto w-full rounded-xl" />;
        return (
          <figure key={block.id} style={style}>
            {href ? (
              <a
                href={href}
                {...(href.startsWith("https://")
                  ? { target: "_blank", rel: "noreferrer noopener" }
                  : {})}
              >
                {image}
              </a>
            ) : (
              image
            )}
            {block.caption ? (
              <figcaption className="mt-2 text-xs leading-5 text-[#17213a]/48">
                {block.caption}
              </figcaption>
            ) : null}
          </figure>
        );
      }
      case "button":
      case "social": {
        const href = safeNewsletterUrl(block.url);
        const outlined = block.type === "button" && block.variant === "outline";
        const linked =
          block.type === "social" || (block.type === "button" && block.variant === "link");
        return href ? (
          <a
            key={block.id}
            href={href}
            {...(href.startsWith("https://")
              ? { target: "_blank", rel: "noreferrer noopener" }
              : {})}
            className={
              "inline-flex rounded-xl px-4 py-2.5 text-sm font-semibold " +
              (linked ? "px-0 underline underline-offset-4 " : "") +
              (outlined ? "border bg-transparent " : "")
            }
            style={{
              backgroundColor: linked || outlined ? "transparent" : presentation?.accentColor,
              borderColor: outlined ? presentation?.accentColor : undefined,
              color: linked || outlined ? presentation?.accentColor : "#ffffff",
              ...style,
            }}
          >
            {block.label}
          </a>
        ) : (
          <span key={block.id} className="inline-flex rounded-xl bg-[#f1f2f5] px-4 py-2.5 text-sm">
            {block.label}
          </span>
        );
      }
      case "divider":
        return <hr key={block.id} className="border-black/[0.08]" style={style} />;
      case "product": {
        const product =
          "product" in block
            ? block.product
            : (products.find((candidate) => candidate.id === block.productId) ?? null);
        return <ProductCard key={block.id} product={product} style={block.style} />;
      }
      case "quote":
        return (
          <blockquote
            key={block.id}
            className="border-l-4 py-2 pl-5 font-ui-display text-xl leading-8"
            style={{ borderColor: presentation?.accentColor, ...style }}
          >
            “{block.text}”
            {block.attribution ? (
              <footer className="mt-2 font-ui-sans text-xs text-[#17213a]/50">
                - {block.attribution}
              </footer>
            ) : null}
          </blockquote>
        );
      case "list": {
        const List = block.ordered ? "ol" : "ul";
        return (
          <List
            key={block.id}
            className={
              (block.ordered ? "list-decimal " : "list-disc ") + "space-y-2 pl-6 text-sm leading-6"
            }
            style={style}
          >
            {block.items.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </List>
        );
      }
      case "spacer":
        return <div key={block.id} aria-hidden="true" style={{ height: block.height }} />;
      case "section": {
        const columnClass =
          block.layout === "two-left"
            ? "sm:grid-cols-[1.6fr_1fr]"
            : block.layout === "two-right"
              ? "sm:grid-cols-[1fr_1.6fr]"
              : "sm:grid-cols-2";
        return (
          <section key={block.id} className={"grid grid-cols-1 gap-5 " + columnClass} style={style}>
            {block.columns.map((column, index) => (
              <div key={index} className="space-y-4">
                <NewsletterBlocks
                  content={column as NewsletterLeafBlock[]}
                  products={products}
                  presentation={presentation}
                />
              </div>
            ))}
          </section>
        );
      }
    }
  });
}

export function NewsletterDocument({
  content,
  subject,
  previewText,
  products = [],
  presentation,
}: {
  content: RenderableBlock[];
  subject?: string;
  previewText?: string;
  products?: NewsletterDocumentProduct[];
  presentation?: NewsletterTemplatePresentation;
}) {
  return (
    <article
      className={newsletterDocumentClassName(presentation)}
      style={{
        backgroundColor: presentation?.backgroundColor ?? "#ffffff",
        maxWidth: presentation?.contentWidth ?? 680,
      }}
    >
      {subject ? (
        <h1
          className={
            (presentation?.headingStyle === "sans" ? "font-ui-sans " : "font-ui-display ") +
            "text-3xl font-semibold"
          }
        >
          {subject}
        </h1>
      ) : null}
      {previewText ? <p className="mt-2 text-sm text-[#17213a]/48">{previewText}</p> : null}
      <div className={newsletterContentClassName(presentation)}>
        <NewsletterBlocks content={content} products={products} presentation={presentation} />
      </div>
    </article>
  );
}
