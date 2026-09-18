import { Buffer } from "node:buffer";
import {
  RequestHttpError,
  enforceTurnstileRequest,
  readResponseText,
} from "./request-security.server";
import {
  MAX_TRANSCRIPTION_BYTES,
  MAX_TRANSCRIPTION_SIZE_LABEL,
  TRANSCRIPTION_API_PATH,
  type TranscriptSegment,
  type TranscriptionResult,
} from "./transcription-tool";

export { TRANSCRIPTION_API_PATH } from "./transcription-tool";

const MIN_TRANSCRIPTION_BYTES = 32;
const MAX_TRANSCRIPT_CHARACTERS = 1_000_000;
const MAX_TRANSCRIPT_SEGMENTS = 50_000;
const MAX_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024;
const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo" as const;
const GROQ_WHISPER_MODEL = "whisper-large-v3-turbo";
const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

type RateLimitBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

export type TranscriptionEnv = {
  AI?: Ai;
  APP_ENV?: string;
  CLOUDFLARE_AI_GATEWAY_ID?: string;
  FREE_TOOLS_TRANSCRIPTION_RATE_LIMITER?: RateLimitBinding;
  GROQ_API_KEY?: string;
  TURNSTILE_VERIFIER_URL?: string;
};

type WhisperResponse = {
  text?: unknown;
  word_count?: unknown;
  segments?: unknown;
  transcription_info?: {
    language?: unknown;
    duration?: unknown;
  };
  language?: unknown;
  duration?: unknown;
};

export type TranscriptionDependencies = {
  runWhisper?: (audioBase64: string, contentType: string, signal: AbortSignal) => Promise<unknown>;
  fetcher?: typeof fetch;
};

type AudioFormat = "aac" | "flac" | "m4a" | "mp3" | "ogg" | "wav" | "webm";

const MIME_FORMATS: Readonly<Record<string, readonly AudioFormat[]>> = {
  "application/octet-stream": ["aac", "flac", "m4a", "mp3", "ogg", "wav", "webm"],
  "application/ogg": ["ogg"],
  "audio/aac": ["aac"],
  "audio/flac": ["flac"],
  "audio/m4a": ["m4a"],
  "audio/mp3": ["mp3"],
  "audio/mp4": ["m4a"],
  "audio/mpeg": ["mp3"],
  "audio/ogg": ["ogg"],
  "audio/vnd.wave": ["wav"],
  "audio/wav": ["wav"],
  "audio/webm": ["webm"],
  "audio/x-flac": ["flac"],
  "audio/x-m4a": ["m4a"],
  "audio/x-wav": ["wav"],
};

function jsonError(message: string, status: number) {
  const headers = new Headers({ "cache-control": "private, no-store" });
  if (status === 429) headers.set("retry-after", "60");
  return Response.json({ error: message }, { status, headers });
}

function normalizedContentType(request: Request) {
  return request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
}

function hasBytes(bytes: Uint8Array, expected: readonly number[], offset = 0) {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function hasAscii(bytes: Uint8Array, expected: string, offset = 0) {
  return hasBytes(
    bytes,
    [...expected].map((character) => character.charCodeAt(0)),
    offset,
  );
}

export function detectTranscriptionAudioFormat(bytes: Uint8Array): AudioFormat | null {
  if (hasAscii(bytes, "RIFF") && hasAscii(bytes, "WAVE", 8)) return "wav";
  if (hasAscii(bytes, "fLaC")) return "flac";
  if (hasAscii(bytes, "OggS")) return "ogg";
  if (hasBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "webm";
  if (hasAscii(bytes, "ftyp", 4)) return "m4a";
  if (bytes[0] === 0xff && (bytes[1] === 0xf1 || bytes[1] === 0xf9)) return "aac";
  if (hasAscii(bytes, "ID3") || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return "mp3";
  return null;
}

async function readBoundedBody(request: Request) {
  const contentLength = request.headers.get("content-length");
  let transportSize: number | null = null;
  if (contentLength) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) throw new Error("invalid-size");
    if (declared > MAX_TRANSCRIPTION_BYTES) throw new Error("too-large");
    transportSize = declared;
  }
  if (!request.body) throw new Error("empty");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_TRANSCRIPTION_BYTES) throw new Error("too-large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }

  if (total < MIN_TRANSCRIPTION_BYTES) throw new Error("empty");
  if (transportSize !== null && transportSize !== total) throw new Error("size-mismatch");
  const clientSize = request.headers.get("x-bento-file-size");
  if (clientSize) {
    const declared = Number(clientSize);
    if (!Number.isSafeInteger(declared) || declared !== total) throw new Error("size-mismatch");
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function normalizeSegment(value: unknown): TranscriptSegment | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { start?: unknown; end?: unknown; text?: unknown };
  if (
    typeof candidate.start !== "number" ||
    !Number.isFinite(candidate.start) ||
    candidate.start < 0 ||
    typeof candidate.end !== "number" ||
    !Number.isFinite(candidate.end) ||
    candidate.end < candidate.start ||
    typeof candidate.text !== "string"
  ) {
    return null;
  }
  const text = candidate.text.trim();
  return text ? { start: candidate.start, end: candidate.end, text } : null;
}

export function normalizeWhisperTranscription(value: unknown): TranscriptionResult | null {
  if (!value || typeof value !== "object") return null;
  const response = value as WhisperResponse;
  if (typeof response.text !== "string") return null;
  const transcript = response.text.trim();
  if (!transcript || transcript.length > MAX_TRANSCRIPT_CHARACTERS) return null;

  if (!Array.isArray(response.segments) || response.segments.length > MAX_TRANSCRIPT_SEGMENTS) {
    return null;
  }
  const segments = response.segments.map(normalizeSegment).filter((item) => item !== null);
  if (!segments.length || segments.length !== response.segments.length) return null;

  const language = response.transcription_info?.language ?? response.language;
  const duration = response.transcription_info?.duration ?? response.duration;
  const wordCount = response.word_count;
  return {
    transcript,
    segments,
    language: typeof language === "string" && language.trim() ? language.trim().slice(0, 32) : null,
    durationSeconds:
      typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? duration : null,
    wordCount:
      typeof wordCount === "number" && Number.isSafeInteger(wordCount) && wordCount >= 0
        ? wordCount
        : transcript.split(/\s+/u).filter(Boolean).length,
  };
}

function isProductionLike(env: TranscriptionEnv) {
  return env.APP_ENV === "production" || env.APP_ENV === "staging";
}

function groqApiKey(env: TranscriptionEnv) {
  return env.GROQ_API_KEY?.trim() || process.env.GROQ_API_KEY?.trim();
}

export function isTranscriptionProviderConfigured(
  env: TranscriptionEnv,
  dependencies: TranscriptionDependencies = {},
) {
  return Boolean(dependencies.runWhisper || env.AI || groqApiKey(env));
}

export function canonicalAudioContentType(format: AudioFormat) {
  const types: Record<AudioFormat, string> = {
    aac: "audio/aac",
    flac: "audio/flac",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    wav: "audio/wav",
    webm: "audio/webm",
  };
  return types[format];
}

async function runGroqWhisper(
  bytes: Uint8Array,
  format: AudioFormat,
  contentType: string,
  apiKey: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
) {
  const uploadBytes = new Uint8Array(bytes.byteLength);
  uploadBytes.set(bytes);
  const body = new FormData();
  body.append(
    "file",
    new Blob([uploadBytes.buffer], {
      type:
        contentType === "application/octet-stream"
          ? canonicalAudioContentType(format)
          : contentType,
    }),
    `audio.${format}`,
  );
  body.append("model", GROQ_WHISPER_MODEL);
  body.append("response_format", "verbose_json");
  body.append("timestamp_granularities[]", "segment");
  body.append("temperature", "0");

  const providerResponse = await fetcher(GROQ_TRANSCRIPTION_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
  });
  if (!providerResponse.ok) throw new Error("Transcription provider request failed");
  return JSON.parse(
    await readResponseText(providerResponse, MAX_PROVIDER_RESPONSE_BYTES),
  ) as unknown;
}

/**
 * Transcribes already-bounded audio bytes through the same Workers AI -> Groq
 * path used by the upload endpoint. Rate limiting deliberately lives at the
 * request boundary so callers can apply it exactly once before reaching here.
 */
export async function transcribeAudioBytes(
  bytes: Uint8Array,
  contentType: string,
  env: TranscriptionEnv,
  signal: AbortSignal,
  dependencies: TranscriptionDependencies = {},
): Promise<TranscriptionResult | null> {
  const normalizedType = contentType.split(";", 1)[0].trim().toLowerCase();
  const format = detectTranscriptionAudioFormat(bytes);
  const allowedFormats = MIME_FORMATS[normalizedType];
  if (!format || !allowedFormats?.includes(format)) return null;

  const localGroqApiKey = groqApiKey(env);
  let rawResult: unknown;
  if (dependencies.runWhisper) {
    const base64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
    rawResult = await dependencies.runWhisper(base64, normalizedType, signal);
  } else if (env.AI) {
    const base64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
    const gatewayId = env.CLOUDFLARE_AI_GATEWAY_ID?.trim();
    try {
      rawResult = await env.AI.run(
        WHISPER_MODEL,
        {
          audio: base64,
          task: "transcribe",
          vad_filter: true,
          condition_on_previous_text: true,
        },
        {
          signal,
          ...(gatewayId ? { gateway: { id: gatewayId, collectLog: false, skipCache: true } } : {}),
        },
      );
      if (!normalizeWhisperTranscription(rawResult)) throw new Error("Invalid transcription");
    } catch (error) {
      if (!localGroqApiKey) throw error;
      rawResult = await runGroqWhisper(
        bytes,
        format,
        normalizedType,
        localGroqApiKey,
        signal,
        dependencies.fetcher ?? fetch,
      );
    }
  } else if (localGroqApiKey) {
    rawResult = await runGroqWhisper(
      bytes,
      format,
      normalizedType,
      localGroqApiKey,
      signal,
      dependencies.fetcher ?? fetch,
    );
  } else {
    return null;
  }

  return normalizeWhisperTranscription(rawResult);
}

async function enforceTranscriptionRateLimit(request: Request, env: TranscriptionEnv) {
  if (!env.FREE_TOOLS_TRANSCRIPTION_RATE_LIMITER) return !isProductionLike(env);
  const clientAddress = request.headers.get("cf-connecting-ip")?.trim() || "missing-cloudflare-ip";
  const result = await env.FREE_TOOLS_TRANSCRIPTION_RATE_LIMITER.limit({
    key: `free-tool-transcription:${clientAddress}`.slice(0, 512),
  });
  return result.success;
}

export async function handleFreeToolTranscriptionRequest(
  request: Request,
  env: TranscriptionEnv,
  dependencies: TranscriptionDependencies = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== TRANSCRIPTION_API_PATH) return null;
  if (request.method !== "POST") {
    return Response.json(
      { error: "Method not allowed" },
      { status: 405, headers: { allow: "POST", "cache-control": "private, no-store" } },
    );
  }

  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin)
    return jsonError("Cross-origin uploads are not allowed", 403);
  if (!isTranscriptionProviderConfigured(env, dependencies)) {
    return jsonError("Transcription is temporarily unavailable", 503);
  }

  let rateLimitAllowed = false;
  try {
    rateLimitAllowed = await enforceTranscriptionRateLimit(request, env);
  } catch {
    return jsonError("Transcription is temporarily unavailable", 503);
  }
  if (!rateLimitAllowed) {
    return env.FREE_TOOLS_TRANSCRIPTION_RATE_LIMITER
      ? jsonError("Too many transcription requests. Please wait a minute and try again.", 429)
      : jsonError("Transcription is temporarily unavailable", 503);
  }

  try {
    await enforceTurnstileRequest(request, env);
  } catch (error) {
    return error instanceof RequestHttpError
      ? jsonError(error.message, error.statusCode)
      : jsonError("Security verification is temporarily unavailable.", 503);
  }

  const contentType = normalizedContentType(request);
  const allowedFormats = MIME_FORMATS[contentType];
  if (!allowedFormats) {
    return jsonError("Upload an MP3, WAV, M4A, WebM audio, OGG, FLAC, or AAC file", 415);
  }

  let bytes: Uint8Array;
  try {
    bytes = await readBoundedBody(request);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid";
    if (reason === "too-large") {
      return jsonError(`Audio files must be ${MAX_TRANSCRIPTION_SIZE_LABEL} or smaller`, 413);
    }
    if (reason === "size-mismatch" || reason === "invalid-size") {
      return jsonError("The uploaded file size could not be verified", 400);
    }
    return jsonError("Choose a non-empty audio file", 400);
  }

  const format = detectTranscriptionAudioFormat(bytes);
  if (!format || !allowedFormats.includes(format)) {
    return jsonError("The file contents do not match a supported audio format", 415);
  }

  try {
    const result = await transcribeAudioBytes(
      bytes,
      contentType,
      env,
      request.signal,
      dependencies,
    );
    if (!result) return jsonError("The audio could not be transcribed", 502);
    return Response.json(result, {
      headers: { "cache-control": "private, no-store", vary: "origin" },
    });
  } catch {
    return jsonError("The audio could not be transcribed. Please try again.", 502);
  }
}
