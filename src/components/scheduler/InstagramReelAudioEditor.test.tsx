import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InstagramReelAudioEditor } from "./InstagramReelAudioEditor";
import { mixInstagramReelAudio } from "@/lib/instagram-reel-audio";

vi.mock("./InstagramAudioCatalog", () => ({ InstagramAudioCatalog: () => null }));
vi.mock("@/lib/instagram-reel-audio", () => ({ mixInstagramReelAudio: vi.fn() }));
const video = {
  key: "users/owner/video/reel.mp4",
  url: "https://example.com/reel.mp4",
  name: "reel.mp4",
  mimeType: "video/mp4",
  size: 1000,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:test-preview");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.mocked(mixInstagramReelAudio).mockResolvedValue(
    new File(["mixed"], "mix.mp4", { type: "video/mp4" }),
  );
});
function setup() {
  const upload = vi.fn().mockResolvedValue({
    ...video,
    key: "users/owner/video/mix.mp4",
    url: "https://example.com/mix.mp4",
  });
  const onChange = vi.fn();
  const result = render(
    <InstagramReelAudioEditor
      video={video}
      saved={null}
      catalogAudio={null}
      catalogConnectionId={null}
      postId={null}
      onCatalogChange={vi.fn()}
      busy={false}
      maxBytes={1000000}
      upload={upload}
      onChange={onChange}
      onProcessing={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Reel audio/ }));
  fireEvent.click(screen.getByRole("button", { name: "Upload" }));
  const track = new File(["track"], "song.wav", { type: "audio/wav" });
  fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [track] } });
  return { ...result, upload, onChange, track };
}
it("previews the selected section without uploading and applies the exact prepared mix", async () => {
  const { upload, onChange, track } = setup();
  fireEvent.change(screen.getByRole("spinbutton", { name: "Audio starts at (seconds)" }), {
    target: { value: "12.5" },
  });
  fireEvent.change(screen.getByRole("slider", { name: "Music volume" }), {
    target: { value: "25" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview Reel mix" }));
  await screen.findByLabelText("Reel audio mix preview");
  expect(mixInstagramReelAudio).toHaveBeenCalledExactlyOnceWith(
    video.url,
    expect.objectContaining({ track, trackStartSeconds: 12.5, trackVolume: 25 }),
  );
  expect(upload).not.toHaveBeenCalled();
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Apply to Reel" }));
  await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
  expect(mixInstagramReelAudio).toHaveBeenCalledOnce();
  expect(upload).toHaveBeenCalledExactlyOnceWith(
    await vi.mocked(mixInstagramReelAudio).mock.results[0].value,
    expect.any(AbortSignal),
  );
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({
      trackStartSeconds: 12.5,
      trackVolume: 25,
      video: expect.objectContaining({ key: "users/owner/video/mix.mp4" }),
    }),
  );
});
it("invalidates the prepared preview when its audio start changes", async () => {
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Preview Reel mix" }));
  await screen.findByLabelText("Reel audio mix preview");
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "3" } });
  expect(screen.queryByLabelText("Reel audio mix preview")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Apply to Reel" }));
  await waitFor(() => expect(mixInstagramReelAudio).toHaveBeenCalledTimes(2));
  expect(mixInstagramReelAudio).toHaveBeenLastCalledWith(
    video.url,
    expect.objectContaining({ trackStartSeconds: 3 }),
  );
});
it("shows failed mixing without uploading or saving an unverified result", async () => {
  vi.mocked(mixInstagramReelAudio).mockRejectedValueOnce(
    new Error("Choose an audio start time before the end of the track."),
  );
  const { upload, onChange } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Preview Reel mix" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/before the end/);
  expect(upload).not.toHaveBeenCalled();
  expect(onChange).not.toHaveBeenCalled();
});

it("cancels a pending preview without uploading or saving", async () => {
  vi.mocked(mixInstagramReelAudio).mockImplementationOnce(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () =>
          reject(new DOMException("Canceled", "AbortError")),
        );
      }),
  );
  const { upload, onChange } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Preview Reel mix" }));
  await waitFor(() => expect(mixInstagramReelAudio).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Preview Reel mix" })).toBeEnabled(),
  );
  expect(upload).not.toHaveBeenCalled();
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
