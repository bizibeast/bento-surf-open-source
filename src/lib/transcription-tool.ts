export const TRANSCRIPTION_API_PATH = "/api/tools/transcribe";
export const MAX_TRANSCRIPTION_BYTES = 12 * 1024 * 1024;
export const MAX_TRANSCRIPTION_SIZE_LABEL = "12 MB";

export const TRANSCRIPTION_FILE_ACCEPT =
  ".mp3,.wav,.m4a,.webm,.ogg,.flac,.aac,audio/mpeg,audio/wav,audio/mp4,audio/webm,audio/ogg,audio/flac,audio/aac";

export type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

export type TranscriptionResult = {
  transcript: string;
  segments: TranscriptSegment[];
  language: string | null;
  durationSeconds: number | null;
  wordCount: number;
};

export type TranscriptExportFormat = "txt" | "srt" | "vtt";

function timestampParts(seconds: number) {
  const milliseconds = Math.max(0, Math.round(seconds * 1_000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1_000);
  const millis = milliseconds % 1_000;
  return [hours, minutes, secs, millis].map((value, index) =>
    String(value).padStart(index === 3 ? 3 : 2, "0"),
  );
}

export function formatTranscriptTimestamp(seconds: number, format: "srt" | "vtt") {
  const [hours, minutes, secs, milliseconds] = timestampParts(seconds);
  return `${hours}:${minutes}:${secs}${format === "srt" ? "," : "."}${milliseconds}`;
}

function cleanCueText(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function createTranscriptExport(
  result: Pick<TranscriptionResult, "transcript" | "segments">,
  format: TranscriptExportFormat,
) {
  if (format === "txt") return `${result.transcript.trim()}\n`;
  if (!result.segments.length) return "";

  const cues = result.segments.map((segment, index) => {
    const timing = `${formatTranscriptTimestamp(segment.start, format)} --> ${formatTranscriptTimestamp(segment.end, format)}`;
    const cue = `${timing}\n${cleanCueText(segment.text)}`;
    return format === "srt" ? `${index + 1}\n${cue}` : cue;
  });
  return `${format === "vtt" ? "WEBVTT\n\n" : ""}${cues.join("\n\n")}\n`;
}

export function safeTranscriptFilename(fileName: string, format: TranscriptExportFormat) {
  const base = fileName
    .replace(/\.[^.]+$/, "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${base || "bento-transcript"}.${format}`;
}
