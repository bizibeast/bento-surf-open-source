import { productWebsite, productAccentTextColor, type ProductWebsite } from "@/lib/product-website";
import { safeMediaUrl } from "@/lib/safe-url";
import { DecodedImage } from "@/components/DecodedImage";

const input = "mt-2 w-full rounded-lg border border-black/10 bg-white px-3 py-2.5 text-sm";
export function ProductWebsiteEditor({
  value,
  onChange,
  title,
  subtitle,
  cover,
}: {
  value?: ProductWebsite;
  onChange: (value: ProductWebsite) => void;
  title: string;
  subtitle: string;
  cover?: string | null;
}) {
  const website = value ?? productWebsite({});
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
          A standalone sales page with its own design. Your profile photo and page tabs stay on your
          creator pages.
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
          Accent color
          <input
            aria-label="Website accent color"
            className={input + " h-11"}
            type="color"
            value={website.accent}
            onChange={(e) => set("accent", e.target.value)}
          />
        </label>
        <label className="text-sm font-medium">
          Background
          <select
            className={input}
            value={website.background}
            onChange={(e) => set("background", e.target.value as ProductWebsite["background"])}
          >
            <option value="paper">Warm paper</option>
            <option value="white">Clean white</option>
            <option value="blue">Soft blue</option>
          </select>
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
        <label className="text-sm font-medium">
          Headline style
          <select
            className={input}
            value={website.font}
            onChange={(e) => set("font", e.target.value as ProductWebsite["font"])}
          >
            <option value="sans">Modern</option>
            <option value="serif">Editorial</option>
          </select>
        </label>
      </div>
      <div
        aria-label="Website preview"
        className="rounded-xl border border-black/10 p-6"
        style={{
          background:
            website.background === "white"
              ? "white"
              : website.background === "blue"
                ? "#f0f5ff"
                : "#faf8f4",
          textAlign: website.layout === "centered" ? "center" : "left",
        }}
      >
        <p className="text-xs font-semibold" style={{ color: "#17213a" }}>
          {website.brand || "Your brand"}
        </p>
        <h4
          className={
            (website.font === "serif" ? "font-display" : "font-sans font-semibold") +
            " mt-6 text-3xl tracking-tight"
          }
        >
          {title || "Your product"}
        </h4>
        <p className="mt-3 text-sm text-muted-foreground">{subtitle}</p>
        {safeMediaUrl(cover) && (
          <DecodedImage
            src={safeMediaUrl(cover)!}
            alt="Product website cover preview"
            className="mt-5 max-h-40 w-full rounded-lg object-cover"
          />
        )}
        <span
          className="mt-5 inline-flex rounded-lg px-4 py-2 text-sm font-semibold"
          style={{ background: website.accent, color: productAccentTextColor(website.accent) }}
        >
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
              { id: crypto.randomUUID(), title: "", body: "", imageUrl: "" },
            ])
          }
        >
          Add section
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Add your story, outcomes, testimonials, FAQs, or images. Reorder sections to shape your
        sales page.
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
        </div>
      ))}
    </section>
  );
}
