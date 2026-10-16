import { useEffect, useState } from "react";
import { agentBrandingSchema, colorOn, type AgentBranding } from "@/lib/content-agent-branding";
import { getContentExistingPhotos } from "@/lib/content-agent-images.functions";
import { getContentPublishingAccounts } from "@/lib/content-agent-preferences.functions";

export function ContentAgentBranding({
  brand,
  onChange,
  destinations,
  onDestinationsChange,
}: {
  brand: AgentBranding;
  onChange: (brand: AgentBranding) => void;
  destinations: Partial<Record<"twitter" | "linkedin" | "instagram", string>>;
  onDestinationsChange: (value: typeof destinations) => void;
}) {
  const [photos, setPhotos] = useState<Awaited<ReturnType<typeof getContentExistingPhotos>>>([]);
  const [accounts, setAccounts] = useState<
    Awaited<ReturnType<typeof getContentPublishingAccounts>>
  >([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    void getContentPublishingAccounts()
      .then((value) => {
        if (active) setAccounts(value);
      })
      .catch(() => {
        if (active) setError("Connected accounts could not be loaded.");
      });
    return () => {
      active = false;
    };
  }, []);
  const checked = agentBrandingSchema.safeParse(brand);
  return (
    <>
      <fieldset className="agent-settings-section space-y-3">
        <legend className="text-sm font-medium">Publishing accounts</legend>
        <p className="text-xs text-muted-foreground">
          Your agent selects these accounts before review. You can change the destination on each
          draft.
        </p>
        {(["linkedin", "twitter", "instagram"] as const).map((platform) => (
          <label key={platform} className="grid gap-1 text-xs">
            {platform === "twitter"
              ? "X / Twitter"
              : platform === "linkedin"
                ? "LinkedIn"
                : "Instagram"}
            <select
              className="content-field"
              value={destinations[platform] || ""}
              onChange={(event) => {
                const next = { ...destinations };
                if (event.target.value) next[platform] = event.target.value;
                else delete next[platform];
                onDestinationsChange(next);
              }}
            >
              <option value="">
                {accounts.some((a) => a.provider === platform)
                  ? "Most recently connected account"
                  : "Connect an account in the scheduler"}
              </option>
              {destinations[platform] && !accounts.some((a) => a.id === destinations[platform]) && (
                <option value={destinations[platform]}>Saved account · reconnect to publish</option>
              )}
              {accounts
                .filter((a) => a.provider === platform)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.provider_handle || platform}
                  </option>
                ))}
            </select>
          </label>
        ))}
        <a className="content-action inline-flex" href="/post-scheduler">
          Manage connections
        </a>
      </fieldset>
      <fieldset className="agent-settings-section space-y-4">
        <legend className="text-sm font-medium">Your carousel style</legend>
        <p className="text-xs text-muted-foreground">
          Finished slides use these colors. Text templates do not use your AI image allowance. Saved
          drafts keep their existing style.
        </p>
        <div className="grid grid-cols-3 gap-3">
          {(
            [
              ["accentColor", "Cover"],
              ["backgroundColor", "Background"],
              ["textColor", "Text"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="grid gap-2 text-xs">
              {label}
              <input
                type="color"
                aria-label={`${label} color`}
                value={brand[key]}
                onChange={(event) => onChange({ ...brand, [key]: event.target.value })}
                className="h-10 w-full cursor-pointer rounded border bg-transparent p-1"
              />
              <span className="font-mono text-[10px]">{brand[key].toUpperCase()}</span>
            </label>
          ))}
        </div>
        {!checked.success && (
          <p role="alert" className="text-xs text-destructive">
            {checked.error.issues[0].message}
          </p>
        )}
        <label className="grid gap-2 text-xs">
          Cover style
          <select
            value={brand.coverStyle}
            className="content-field"
            onChange={(e) =>
              onChange({ ...brand, coverStyle: e.target.value as AgentBranding["coverStyle"] })
            }
          >
            <option value="text">Text-only carousel</option>
            <option value="portrait">My portrait, then text slides</option>
          </select>
        </label>
        <div aria-label="Carousel color preview" className="grid grid-cols-2 gap-3">
          <div
            className="flex aspect-[4/5] flex-col rounded-xl p-5"
            style={{ background: brand.accentColor, color: colorOn(brand.accentColor) }}
          >
            <span className="mb-auto text-[10px] uppercase tracking-widest">Your perspective</span>
            <strong className="text-xl leading-tight">An idea worth sharing.</strong>
            <span className="mt-3 text-xs">A clear point of view. In your own voice.</span>
            <span className="mt-auto pt-5 text-[10px]">01 / 05</span>
          </div>
          <div
            className="flex aspect-[4/5] flex-col rounded-xl border p-5"
            style={{ background: brand.backgroundColor, color: brand.textColor }}
          >
            <span className="mb-auto h-1 w-8 rounded" style={{ background: brand.accentColor }} />
            <strong className="text-xl leading-tight">One useful takeaway.</strong>
            <span className="mt-3 text-xs">
              Simple, readable slides that make the next step clear.
            </span>
            <span className="mt-auto pt-5 text-[10px]">02 / 05</span>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Choose a portrait for covers and as a fallback for LinkedIn and X photos. Choose one that
          clearly shows you. This reuses your photo inside Bento.
        </p>
        <button
          type="button"
          className="content-action"
          onClick={async () => {
            try {
              setPhotos(await getContentExistingPhotos());
              setLoaded(true);
              setError("");
            } catch {
              setError("Your indexed photos could not be loaded.");
            }
          }}
        >
          Choose my portrait{brand.heroPhotoId ? " · selected" : ""}
        </button>
        {loaded && photos.length === 0 && (
          <p className="text-xs">
            No indexed photos yet. Connect and index your social content, or use text-only carousels
            for now.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {photos.map((photo) => (
            <button
              key={photo.id}
              type="button"
              aria-label="Use this portrait"
              aria-pressed={brand.heroPhotoId === photo.id}
              className={`overflow-hidden rounded-lg border-2 ${brand.heroPhotoId === photo.id ? "border-blue-600 ring-2 ring-blue-100" : "border-transparent"}`}
              onClick={() => onChange({ ...brand, heroPhotoId: photo.id })}
            >
              <img src={photo.url} alt="Your indexed photo" className="size-20 object-cover" />
            </button>
          ))}
        </div>
        {brand.heroPhotoId && (
          <button
            type="button"
            className="content-action"
            onClick={() => onChange({ ...brand, heroPhotoId: null, coverStyle: "text" })}
          >
            Clear portrait
          </button>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </fieldset>
    </>
  );
}
