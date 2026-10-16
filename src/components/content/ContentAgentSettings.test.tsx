import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContentAgentSettings } from "./ContentAgentSettings";
vi.mock("@/lib/content-agent-preferences.functions", () => ({
  getContentPublishingAccounts: async () => [],
}));

const imageMocks = vi.hoisted(() => ({ settings: vi.fn(), photos: vi.fn() }));
vi.mock("@/lib/content-agent-images.functions", () => ({
  getContentImageSettings: imageMocks.settings,
  getContentReferencePhotos: imageMocks.photos,
  getContentExistingPhotos: imageMocks.photos,
}));
beforeEach(() => {
  vi.clearAllMocks();
  imageMocks.settings.mockResolvedValue({
    available: true,
    quota: { successful: 12, pending: 2, resetAt: "2026-11-01T00:00:00Z" },
  });
  imageMocks.photos.mockResolvedValue([
    { id: "photo", url: "https://bento.surf/photo.jpg", assessment: "manual" },
  ]);
});
const preferences = {
  user_id: "workspace",
  display_name: "Milo",
  proactive_paused: false,
  generate_images: false,
  use_face_references: false,
  platforms: ["twitter", "linkedin", "instagram"] as ("twitter" | "linkedin" | "instagram")[],
};

describe("ContentAgentSettings", () => {
  it("saves rename, pause and platforms with image and face consent kept separate", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<ContentAgentSettings preferences={preferences} onSave={onSave} onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "Agent settings" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "  Sage  " } });
    fireEvent.click(screen.getByLabelText("Pause proactive messages"));
    fireEvent.click(screen.getByLabelText("X posts · 70% with photos"));
    expect(screen.getByLabelText("Use my indexed face photos")).toBeDisabled();
    await waitFor(() => expect(screen.getByLabelText("Generate AI images")).not.toBeDisabled());
    fireEvent.click(screen.getByLabelText("Generate AI images"));
    expect(screen.getByLabelText("Use my indexed face photos")).not.toBeChecked();
    expect(screen.queryByText(/Enable AI images first/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        displayName: "Sage",
        proactivePaused: true,
        generateImages: true,
        useFaceReferences: false,
        platforms: ["linkedin", "instagram"],
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });
  it("clears face consent when image generation is turned off and requires a fresh opt-in", () => {
    render(
      <ContentAgentSettings
        preferences={{ ...preferences, generate_images: true, use_face_references: true }}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText("Generate AI images"));
    expect(screen.getByLabelText("Use my indexed face photos")).not.toBeChecked();
    fireEvent.click(screen.getByLabelText("Generate AI images"));
    expect(screen.getByLabelText("Use my indexed face photos")).not.toBeChecked();
  });
  it("retains edits and reports a failed save, and rejects a blank name", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("Could not save"));
    render(<ContentAgentSettings preferences={preferences} onSave={onSave} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Sage" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not save"));
    expect(screen.getByLabelText("Agent name")).toHaveValue("Sage");
  });
});

it("allows revocation and removing photos during provider unavailability", async () => {
  imageMocks.settings.mockResolvedValue({
    available: false,
    quota: { successful: 99, pending: 1, resetAt: "2026-11-01T00:00:00Z" },
  });
  const save = vi.fn();
  render(
    <ContentAgentSettings
      preferences={{
        ...preferences,
        generate_images: true,
        use_face_references: true,
        reference_photo_ids: ["photo"],
      }}
      onSave={save}
      onClose={vi.fn()}
    />,
  );
  await screen.findByText(/99 \/ 100 successful/);
  expect(screen.getByLabelText("Generate AI images")).not.toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Remove selected photos" }));
  fireEvent.click(screen.getByLabelText("Generate AI images"));
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        generateImages: false,
        useFaceReferences: false,
        referencePhotoIds: [],
      }),
    ),
  );
});
it("keeps photo selection local until Save and requires explicit creator confirmation", async () => {
  const save = vi.fn();
  const close = vi.fn();
  render(<ContentAgentSettings preferences={preferences} onSave={save} onClose={close} />);
  fireEvent.click(screen.getByRole("button", { name: "Review my photos" }));
  const option = await screen.findByLabelText(/Manual review/);
  fireEvent.click(option);
  expect(screen.getByLabelText(/I confirm these photos show me/)).not.toBeChecked();
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(save).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
});

it("reports unavailable rollout and provider without allowing preferences to enable service", async () => {
  imageMocks.settings.mockResolvedValue({
    available: false,
    proactiveAvailable: false,
    quota: { successful: 0, pending: 0, resetAt: "2026-11-01T00:00:00Z" },
  });
  render(<ContentAgentSettings preferences={preferences} onSave={vi.fn()} onClose={vi.fn()} />);
  await screen.findByText(/Proactive delivery is not available/);
  expect(screen.getByLabelText("Generate AI images")).toBeDisabled();
  expect(screen.getByLabelText("Agent name")).not.toBeDisabled();
  expect(screen.getByText(/Generation is currently unavailable/)).toBeVisible();
});
