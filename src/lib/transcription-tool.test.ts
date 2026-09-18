import { describe, expect, it } from "vitest";
import {
  createTranscriptExport,
  formatTranscriptTimestamp,
  safeTranscriptFilename,
} from "./transcription-tool";

const transcript = {
  transcript: "Hello world.\nThis is Bento.",
  segments: [
    { start: 0, end: 1.234, text: "Hello world." },
    { start: 61.005, end: 63.4, text: "This is Bento." },
  ],
};

describe("transcript exports", () => {
  it("formats WebVTT with millisecond timestamps", () => {
    expect(createTranscriptExport(transcript, "vtt")).toBe(
      "WEBVTT\n\n00:00:00.000 --> 00:00:01.234\nHello world.\n\n00:01:01.005 --> 00:01:03.400\nThis is Bento.\n",
    );
  });

  it("formats numbered SRT cues with comma timestamps", () => {
    expect(createTranscriptExport(transcript, "srt")).toBe(
      "1\n00:00:00,000 --> 00:00:01,234\nHello world.\n\n2\n00:01:01,005 --> 00:01:03,400\nThis is Bento.\n",
    );
  });

  it("exports plain text and returns no fake timed export without segments", () => {
    expect(createTranscriptExport(transcript, "txt")).toBe("Hello world.\nThis is Bento.\n");
    expect(createTranscriptExport({ transcript: "Hello", segments: [] }, "srt")).toBe("");
    expect(createTranscriptExport({ transcript: "Hello", segments: [] }, "vtt")).toBe("");
  });

  it("formats long timestamps and safe local filenames", () => {
    expect(formatTranscriptTimestamp(3_661.009, "vtt")).toBe("01:01:01.009");
    expect(safeTranscriptFilename("My launch / interview 🎙️.mp3", "srt")).toBe(
      "My-launch-interview.srt",
    );
  });
});
