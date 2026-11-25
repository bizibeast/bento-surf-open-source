import { useState } from "react";
import type { AgentBranding } from "@/lib/content-agent-branding";
import { listHeyGenAvatars, listHeyGenVoices } from "@/lib/external-tools.functions";
import { AvatarLookGallery } from "@/components/content-studio/avatar-look-gallery";

export function BennyPresenterSettings({
  brand,
  onChange,
}: {
  brand: AgentBranding;
  onChange: (brand: AgentBranding) => void;
}) {
  const [billing, setBilling] = useState<"managed" | "byok">(brand.presenter?.billing ?? "managed");
  const [scope, setScope] = useState<"public" | "private">(brand.presenter?.scope ?? "public");
  const [avatars, setAvatars] = useState<Awaited<ReturnType<typeof listHeyGenAvatars>> | null>(
    null,
  );
  const [voices, setVoices] = useState<Awaited<ReturnType<typeof listHeyGenVoices>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = async (more = false) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const [a, v] = await Promise.all([
        more && !avatars?.nextToken
          ? Promise.resolve(avatars!)
          : listHeyGenAvatars({
              data: { billing, scope, token: more ? avatars?.nextToken || undefined : undefined },
            }),
        more && !voices?.nextToken
          ? Promise.resolve(voices!)
          : listHeyGenVoices({
              data: { billing, scope, token: more ? voices?.nextToken || undefined : undefined },
            }),
      ]);
      setAvatars({
        ...a,
        avatars: [
          ...new Map(
            [...(more ? avatars?.avatars || [] : []), ...a.avatars].map((x) => [x.id, x]),
          ).values(),
        ],
      });
      setVoices({
        ...v,
        voices: [
          ...new Map(
            [...(more ? voices?.voices || [] : []), ...v.voices].map((x) => [x.id, x]),
          ).values(),
        ],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Presenter choices could not be loaded.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <fieldset className="agent-settings-section space-y-4">
      <legend className="text-sm font-medium">Your presenter</legend>
      <p className="text-xs text-muted-foreground">
        Choose a face and voice for future avatar Reels. Benny uses it when you ask for a presenter.
        Existing videos keep their current face; production still needs your approval.
      </p>
      {brand.presenter && (
        <p className="text-sm">
          Selected presenter: <strong>{brand.presenter.name}</strong>
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-2 text-xs">
          Presenter library
          <select
            className="content-field"
            disabled={busy}
            value={billing}
            onChange={(e) => {
              setBilling(e.target.value as typeof billing);
              setAvatars(null);
              setVoices(null);
            }}
          >
            <option value="managed">Bento assigned looks</option>
            <option value="byok">My connected account</option>
          </select>
        </label>
        <label className="grid gap-2 text-xs">
          Look collection
          <select
            className="content-field"
            disabled={busy}
            value={scope}
            onChange={(e) => {
              setScope(e.target.value as typeof scope);
              setAvatars(null);
              setVoices(null);
            }}
          >
            <option value="public">Stock looks</option>
            <option value="private">My looks</option>
          </select>
        </label>
      </div>
      <button type="button" className="content-action" disabled={busy} onClick={() => void load()}>
        {busy ? "Loading presenter choices…" : "Browse presenter looks"}
      </button>
      {avatars && (
        <AvatarLookGallery
          looks={avatars.avatars}
          selectedId={brand.presenter?.avatarId ?? ""}
          disabled={busy}
          onSelect={(id) => {
            const avatar = avatars.avatars.find((a) => a.id === id);
            if (!avatar) {
              onChange({ ...brand, presenter: null });
              return;
            }
            const voice =
              voices?.voices.find((v) => v.id === avatar.defaultVoiceId) ||
              voices?.voices.find((v) => v.id === brand.presenter?.voiceId);
            onChange({
              ...brand,
              presenter: {
                avatarId: avatar.id,
                name: avatar.name,
                voiceId: voice?.id ?? null,
                billing,
                scope,
              },
            });
          }}
        />
      )}
      {brand.presenter && voices && (
        <label className="grid gap-2 text-xs">
          Presenter voice
          <select
            className="content-field"
            disabled={busy}
            value={brand.presenter.voiceId ?? ""}
            onChange={(e) =>
              onChange({
                ...brand,
                presenter: { ...brand.presenter!, voiceId: e.target.value || null },
              })
            }
          >
            <option value="">Choose a voice</option>
            {brand.presenter.voiceId &&
              !voices.voices.some((v) => v.id === brand.presenter?.voiceId) && (
                <option value={brand.presenter.voiceId}>Saved voice</option>
              )}
            {voices.voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.language ? ` · ${v.language}` : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      {(avatars?.nextToken || voices?.nextToken) && (
        <button
          type="button"
          className="content-action"
          disabled={busy}
          onClick={() => void load(true)}
        >
          More presenter choices
        </button>
      )}
      {brand.presenter && !avatars && (
        <button
          type="button"
          className="content-action"
          disabled={busy}
          onClick={() => onChange({ ...brand, presenter: null })}
        >
          Clear presenter selection
        </button>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Browsing and selecting do not generate footage. Save preferences to keep your choice.
      </p>
    </fieldset>
  );
}
