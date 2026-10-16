import { useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { ContentAgentPreferences } from "@/lib/content-agent-identity.server";
import type { ContentAgentPreferencesInput } from "@/lib/content-agent-preferences.functions";
import { agentBranding, agentBrandingSchema } from "@/lib/content-agent-branding";
import { ContentAgentBranding } from "./ContentAgentBranding";

import {
  getContentImageSettings,
  getContentReferencePhotos,
} from "@/lib/content-agent-images.functions";

const platforms = [
  ["twitter", "X posts · 70% with photos"],
  ["linkedin", "LinkedIn posts with photos"],
  ["instagram", "Instagram static carousels"],
] as const;

export function ContentAgentSettings({
  preferences,
  onSave,
  onClose,
  imageControls,
  referenceControls,
}: {
  preferences: ContentAgentPreferences;
  onSave: (value: ContentAgentPreferencesInput) => Promise<unknown>;
  onClose: () => void;
  imageControls?: ReactNode;
  referenceControls?: ReactNode;
}) {
  const returnFocus = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const [name, setName] = useState(preferences.display_name);
  const [paused, setPaused] = useState(preferences.proactive_paused);
  const [images, setImages] = useState(preferences.generate_images);
  const [references, setReferences] = useState(preferences.use_face_references);
  const [selectedPlatforms, setSelectedPlatforms] = useState(preferences.platforms);
  const [branding, setBranding] = useState(() => agentBranding(preferences.branding));
  const [destinations, setDestinations] = useState(preferences.destination_accounts || {});
  const [imageState, setImageState] =
    useState<Awaited<ReturnType<typeof getContentImageSettings>>>();
  const [photos, setPhotos] = useState<Awaited<ReturnType<typeof getContentReferencePhotos>>>([]);
  const [referenceIds, setReferenceIds] = useState(preferences.reference_photo_ids || []);
  const [confirmed, setConfirmed] = useState(false);
  const [selectionChanged, setSelectionChanged] = useState(false);
  useEffect(() => {
    let active = true;
    void getContentImageSettings()
      .then((value) => {
        if (active) setImageState(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="content-workspace agent-settings-dialog"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.current?.focus();
        }}
      >
        <div className="pr-10">
          <DialogTitle className="text-lg font-semibold">Agent settings</DialogTitle>
          <DialogDescription className="mt-2">
            Make your content partner your own.
          </DialogDescription>
        </div>
        <form
          className="agent-settings-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (saving) return;
            const displayName = name.trim();
            if (
              !displayName ||
              displayName.length > 80 ||
              Array.from(name).some(
                (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
              )
            ) {
              setError("Choose a name from 1 to 80 characters without control characters.");
              return;
            }
            setError("");
            setSaving(true);
            try {
              const checkedBrand = agentBrandingSchema.parse(branding);
              if (checkedBrand.coverStyle === "portrait" && !checkedBrand.heroPhotoId)
                throw new Error("Choose your portrait, or select a text-only cover.");
              await onSave({
                displayName,
                proactivePaused: paused,
                generateImages: images,
                useFaceReferences: images && references,
                platforms: selectedPlatforms,
                ...(JSON.stringify(checkedBrand) !==
                JSON.stringify(agentBranding(preferences.branding))
                  ? { branding: checkedBrand }
                  : {}),
                ...(JSON.stringify(destinations) !==
                JSON.stringify(preferences.destination_accounts || {})
                  ? { destinationAccounts: destinations }
                  : {}),
                ...(selectionChanged
                  ? {
                      referencePhotoIds: referenceIds,
                      referencesConfirmed: confirmed || referenceIds.length === 0,
                    }
                  : {}),
              });
              onClose();
            } catch (cause) {
              setError(
                cause instanceof Error
                  ? cause.message
                  : "Settings could not be saved. Your edits are still here.",
              );
            } finally {
              setSaving(false);
            }
          }}
        >
          <fieldset disabled={saving} className="space-y-6">
            <label className="block text-sm font-medium">
              Agent name
              <input
                className="content-field mt-2"
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
                autoComplete="off"
              />
            </label>
            <label className="agent-setting-option">
              <input
                type="checkbox"
                aria-label="Pause proactive messages"
                checked={paused}
                onChange={(event) => setPaused(event.target.checked)}
              />
              <span>
                <span className="agent-setting-label">Pause proactive messages</span>
                <span className="agent-setting-description">
                  {imageState?.proactiveAvailable
                    ? "You can still chat anytime. When active, your agent sends up to one useful message a day and three a week."
                    : "Proactive delivery is not available for this workspace yet. You can chat anytime and save your preferences for when it becomes available."}
                </span>
              </span>
            </label>
            <fieldset className="agent-settings-section">
              <legend className="mb-3 text-sm font-medium">Content preferences</legend>
              <p className="mb-3 text-xs text-muted-foreground">
                Choose the formats your agent should suggest. You review every post before
                scheduling or publishing.
              </p>
              {platforms.map(([platform, label]) => (
                <label key={platform} className="agent-setting-option mb-3">
                  <input
                    type="checkbox"
                    checked={selectedPlatforms.includes(platform)}
                    onChange={(event) =>
                      setSelectedPlatforms((current) =>
                        event.target.checked
                          ? [...current, platform]
                          : current.filter((value) => value !== platform),
                      )
                    }
                  />
                  <span className="agent-setting-label">{label}</span>
                </label>
              ))}
            </fieldset>
            <ContentAgentBranding
              brand={branding}
              onChange={setBranding}
              destinations={destinations}
              onDestinationsChange={setDestinations}
            />
            <div className="agent-settings-section space-y-4">
              <label className="agent-setting-option">
                <input
                  type="checkbox"
                  aria-label="Generate AI images"
                  checked={images}
                  disabled={!images && !imageState?.available}
                  onChange={(event) => {
                    setImages(event.target.checked);
                    if (!event.target.checked) setReferences(false);
                  }}
                />
                <span>
                  <span className="agent-setting-label">Generate AI images with drafts</span>
                  <span className="agent-setting-description">
                    Prepare a useful visual with new drafts. Up to 100 successful images per
                    workspace each calendar month.
                  </span>
                </span>
              </label>
              {imageState && (
                <p className="text-xs">
                  {imageState.quota.successful} / 100 successful · {imageState.quota.pending}{" "}
                  pending (including prior months). Resets{" "}
                  {new Date(imageState.quota.resetAt).toLocaleDateString(undefined, {
                    timeZone: "UTC",
                  })}{" "}
                  UTC.
                </p>
              )}
              {!imageState?.available && (
                <p className="text-xs">
                  Generation is currently unavailable. You can still disable it or remove reference
                  photos.
                </p>
              )}
              {imageControls}
              <label className="agent-setting-option">
                <input
                  type="checkbox"
                  aria-label="Use my indexed face photos"
                  disabled={!references && (!images || !imageState?.available)}
                  checked={references}
                  onChange={(event) => setReferences(event.target.checked)}
                />
                <span>
                  <span className="agent-setting-label">Use my indexed face photos</span>
                  <span className="agent-setting-description">
                    A separate opt-in: share selected indexed face photos with API Mart as
                    references when generating images. {!images && "Enable AI images first."}
                  </span>
                </span>
              </label>
              {referenceControls}
              <p className="text-xs">
                {referenceIds.length} selected reference photos. Reviewing photos does not send them
                to API Mart.
              </p>
              <button
                type="button"
                className="content-action"
                onClick={async () => {
                  try {
                    setPhotos(await getContentReferencePhotos());
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "Photos unavailable.");
                  }
                }}
              >
                Review my photos
              </button>
              {referenceIds.length > 0 && (
                <button
                  type="button"
                  className="content-action"
                  onClick={() => {
                    setReferenceIds([]);
                    setReferences(false);
                    setSelectionChanged(true);
                    setConfirmed(false);
                  }}
                >
                  Remove selected photos
                </button>
              )}
              <div className="flex flex-wrap gap-2">
                {photos.map((photo) => (
                  <label key={photo.id} className="text-xs">
                    <img
                      src={photo.url}
                      alt="Reference candidate"
                      className="size-20 object-cover"
                    />
                    <input
                      type="checkbox"
                      checked={referenceIds.includes(photo.id)}
                      disabled={!referenceIds.includes(photo.id) && referenceIds.length >= 4}
                      onChange={(e) => {
                        setReferenceIds((ids) =>
                          e.target.checked
                            ? [...ids, photo.id]
                            : ids.filter((id) => id !== photo.id),
                        );
                        setSelectionChanged(true);
                        setConfirmed(false);
                      }}
                    />
                    {photo.assessment === "single_face"
                      ? "One clear face detected; confirm it is you"
                      : "Manual review; face and resolution not automatically assessed"}
                  </label>
                ))}
              </div>
              {selectionChanged && referenceIds.length > 0 && (
                <label className="agent-setting-option">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  <span>
                    I confirm these photos show me, each has one clear visible face at a useful
                    resolution (at least 512 × 512 pixels), and these are the photos I want used as
                    generation references when reference use is enabled.
                  </span>
                </label>
              )}
            </div>
          </fieldset>
          {error && (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <button type="button" className="content-action" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="content-action content-action-primary"
              disabled={saving}
            >
              {saving ? "Saving…" : "Save settings"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
