import { productWebsite, type ProductWebsite } from "@/lib/product-website";
import { BuyerQuestionsEditor } from "./BuyerQuestionsEditor";
import { MAX_COMMERCE_BUYER_QUESTIONS } from "@/lib/commerce-buyer-questions";
import { safeMediaUrl } from "@/lib/safe-url";
import { DecodedImage } from "@/components/DecodedImage";

const input = "mt-2 w-full rounded-lg border border-black/10 bg-white px-3 py-2.5 text-sm";
export function ProductWebsiteEditor({
  value,
  onChange,
  title,
  subtitle,
  cover,
  kind,
  legacyBuyerQuestions = [],
}: {
  value?: ProductWebsite;
  onChange: (value: ProductWebsite) => void;
  title: string;
  subtitle: string;
  cover?: string | null;
  kind?: string;
  legacyBuyerQuestions?: string[];
}) {
  const website = value ?? productWebsite({});
  const questionLimit =
    kind === "priority_dm" ? MAX_COMMERCE_BUYER_QUESTIONS - 1 : MAX_COMMERCE_BUYER_QUESTIONS;
  const legacyQuestions = kind === "custom_product" ? legacyBuyerQuestions : [];
  const allQuestions = website.sections.flatMap((section) => section.buyerQuestions || []);
  const set = <K extends keyof ProductWebsite>(key: K, next: ProductWebsite[K]) =>
    onChange({ ...website, [key]: next });
  const move = (index: number, direction: number) => {
    const sections = [...website.sections];
    const [section] = sections.splice(index, 1);
    sections.splice(index + direction, 0, section);
    set("sections", sections);
  };
  return (
    <section className="space-y-5">
      <div>
        <h3 className="text-xl font-semibold">Your product website</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Your product page inherits your Link theme: background, accent color and typography. Keep
          your brand, page layout and custom sections here; edit shared styling in Link.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-medium">
          Brand name
          <input
            className={input}
            maxLength={80}
            value={website.brand}
            onChange={(e) => set("brand", e.target.value)}
            placeholder="Your business or studio"
          />
        </label>
        <label className="text-sm font-medium">
          Hero alignment
          <select
            className={input}
            value={website.layout}
            onChange={(e) => set("layout", e.target.value as ProductWebsite["layout"])}
          >
            <option value="split">Left aligned</option>
            <option value="centered">Centered</option>
          </select>
        </label>
      </div>
      <div
        aria-label="Website preview"
        className="rounded-xl border border-black/10 bg-muted/30 p-6"
        style={{
          textAlign: website.layout === "centered" ? "center" : "left",
        }}
      >
        <p className="text-xs font-semibold">{website.brand || "Your brand"}</p>
        <h4 className="mt-6 text-3xl font-semibold tracking-tight">{title || "Your product"}</h4>
        <p className="mt-3 text-sm text-muted-foreground">{subtitle}</p>
        {safeMediaUrl(cover) && (
          <DecodedImage
            src={safeMediaUrl(cover)!}
            alt="Product website cover preview"
            className="mt-5 max-h-40 w-full rounded-lg object-cover"
          />
        )}
        <span className="mt-5 inline-flex rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">
          Get it now
        </span>
      </div>
      <div className="flex items-center justify-between">
        <h4 className="font-semibold">Custom sections</h4>
        <button
          type="button"
          disabled={website.sections.length >= 12}
          className="rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-40"
          onClick={() =>
            set("sections", [
              ...website.sections,
              { id: crypto.randomUUID(), title: "", body: "", imageUrl: "", buyerQuestions: [] },
            ])
          }
        >
          Add section
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Add your story, outcomes, testimonials, images or questions buyers answer before checkout.
        Reorder sections to shape your sales page.
      </p>
      {website.sections.map((section, index) => (
        <div key={section.id} className="space-y-3 rounded-xl border border-black/10 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm font-semibold">Section {index + 1}</span>
            <div className="flex gap-2">
              <button
                type="button"
                aria-label={"Move section " + (index + 1) + " up"}
                disabled={index === 0}
                onClick={() => move(index, -1)}
                className="rounded border px-2 py-1 text-xs disabled:opacity-30"
              >
                Move up
              </button>
              <button
                type="button"
                aria-label={"Move section " + (index + 1) + " down"}
                disabled={index === website.sections.length - 1}
                onClick={() => move(index, 1)}
                className="rounded border px-2 py-1 text-xs disabled:opacity-30"
              >
                Move down
              </button>
              <button
                type="button"
                onClick={() =>
                  set(
                    "sections",
                    website.sections.filter((item) => item.id !== section.id),
                  )
                }
                className="rounded px-2 py-1 text-xs text-rose-700"
              >
                Remove
              </button>
            </div>
          </div>
          {(["title", "body", "imageUrl"] as const).map((key) => (
            <label key={key} className="block text-sm">
              {key === "title" ? "Heading" : key === "body" ? "Content" : "Image URL (optional)"}
              {key === "body" ? (
                <textarea
                  className={input}
                  rows={5}
                  maxLength={5000}
                  value={section[key]}
                  onChange={(e) =>
                    set(
                      "sections",
                      website.sections.map((item) =>
                        item.id === section.id ? { ...item, [key]: e.target.value } : item,
                      ),
                    )
                  }
                />
              ) : (
                <input
                  type={key === "imageUrl" ? "url" : "text"}
                  className={input}
                  maxLength={key === "title" ? 120 : 2048}
                  value={section[key]}
                  onChange={(e) =>
                    set(
                      "sections",
                      website.sections.map((item) =>
                        item.id === section.id ? { ...item, [key]: e.target.value } : item,
                      ),
                    )
                  }
                />
              )}
            </label>
          ))}
          {kind !== "lead_form" && kind !== "bento_affiliate" ? (
            <BuyerQuestionsEditor
              value={section.buyerQuestions || []}
              maxQuestions={Math.max(
                0,
                questionLimit -
                  legacyQuestions.length -
                  allQuestions.length +
                  (section.buyerQuestions?.length || 0),
              )}
              existingQuestions={[
                ...legacyQuestions,
                ...website.sections
                  .filter((item) => item.id !== section.id)
                  .flatMap((item) =>
                    (item.buyerQuestions || []).map((question) => question.question),
                  ),
              ]}
              onChange={(buyerQuestions) =>
                set(
                  "sections",
                  website.sections.map((item) =>
                    item.id === section.id ? { ...item, buyerQuestions } : item,
                  ),
                )
              }
            />
          ) : null}
        </div>
      ))}
    </section>
  );
}
