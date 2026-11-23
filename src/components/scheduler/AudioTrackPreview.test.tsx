import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AudioTrackPreview } from "./AudioTrackPreview";

it("seeks a listening preview and follows the selected track volume", () => {
  const { rerender } = render(<AudioTrackPreview src="/track.wav" volume={25} />);
  const audio = screen.getByLabelText("Track preview") as HTMLAudioElement;
  expect(audio.volume).toBe(0.25);
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "12.5" } });
  expect(audio.currentTime).toBe(12.5);
  audio.currentTime = 17;
  fireEvent.click(screen.getByRole("button", { name: "Use current position" }));
  expect(screen.getByRole("spinbutton")).toHaveValue(17);
  rerender(<AudioTrackPreview src="/track.wav" volume={70} />);
  expect(audio.volume).toBe(0.7);
});

it("reports a start at the end of a track and surfaces failed preview loads", () => {
  render(<AudioTrackPreview src="/track.wav" volume={100} />);
  const audio = screen.getByLabelText("Track preview");
  Object.defineProperty(audio, "duration", { value: 20 });
  fireEvent.loadedMetadata(audio);
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "20" } });
  expect(screen.getByRole("alert")).toHaveTextContent(/before the end/);
  fireEvent.error(audio);
  expect(screen.getByRole("status")).toHaveTextContent(/could not load/);
  expect(screen.getByRole("button", { name: "Use current position" })).toBeDisabled();
});

it("passes fractional positions to the uploaded-track editor and respects processing state", () => {
  const onStartChange = vi.fn();
  const { rerender } = render(
    <AudioTrackPreview
      src="/track.wav"
      volume={40}
      startSeconds={3}
      onStartChange={onStartChange}
    />,
  );
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "4.7" } });
  expect(onStartChange).toHaveBeenCalledExactlyOnceWith(4.7);
  rerender(
    <AudioTrackPreview
      src="/track.wav"
      volume={40}
      startSeconds={4.7}
      onStartChange={onStartChange}
      disabled
    />,
  );
  expect(screen.getByRole("spinbutton")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Use current position" })).toBeDisabled();
});
