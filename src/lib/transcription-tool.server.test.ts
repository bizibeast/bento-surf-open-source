import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectTranscriptionAudioFormat,
  handleFreeToolTranscriptionRequest,
  normalizeWhisperTranscription,
} from "./transcription-tool.server";
import { MAX_TRANSCRIPTION_BYTES, TRANSCRIPTION_API_PATH } from "./transcription-tool";
import { TURNSTILE_ACTION, TURNSTILE_TOKEN_HEADER } from "./turnstile";

afterEach(() => vi.unstubAllGlobals());

function wavBytes(size = 64) {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WAVE"), 8);
  return bytes;
}

function uploadRequest(body: Uint8Array = wavBytes(), headers: Record<string, string> = {}) {
  const requestBytes = new Uint8Array(body.byteLength);
  requestBytes.set(body);
  return new Request(`http://localhost:8080${TRANSCRIPTION_API_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "audio/wav",
      "x-bento-file-size": String(body.byteLength),
      origin: "http://localhost:8080",
      ...headers,
    },
    body: requestBytes.buffer,
  });
}

const whisperOutput = {
  text: "Hello from Bento.",
  word_count: 3,
  transcription_info: { language: "en", duration: 2.5 },
  segments: [{ start: 0, end: 2.5, text: " Hello from Bento. " }],
};

describe("free upload transcription endpoint", () => {
  it("transcribes an intact validated audio file without storing it", async () => {
    const runWhisper = vi.fn().mockResolvedValue(whisperOutput);
    const response = await handleFreeToolTranscriptionRequest(
      uploadRequest(),
      { APP_ENV: "development" },
      { runWhisper },
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      transcript: "Hello from Bento.",
      wordCount: 3,
      language: "en",
      durationSeconds: 2.5,
      segments: [{ start: 0, end: 2.5, text: "Hello from Bento." }],
    });
    expect(runWhisper).toHaveBeenCalledOnce();
    expect(runWhisper.mock.calls[0][1]).toBe("audio/wav");
    expect(Buffer.from(runWhisper.mock.calls[0][0], "base64")).toEqual(Buffer.from(wavBytes()));
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
  });

  it("uses native Groq multipart transcription when Workers AI is unavailable", async () => {
    const fetcher = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toEqual({ Authorization: "Bearer local-groq-key" });
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      expect(form.get("model")).toBe("whisper-large-v3-turbo");
      expect(form.get("response_format")).toBe("verbose_json");
      expect(form.get("timestamp_granularities[]")).toBe("segment");
      const file = form.get("file");
      expect(file).toBeInstanceOf(File);
      expect((file as File).name).toBe("audio.wav");
      expect((file as File).type).toBe("audio/wav");
      return Response.json({
        text: "Hello from local Groq.",
        language: "en",
        duration: 1.5,
        segments: [{ start: 0, end: 1.5, text: "Hello from local Groq." }],
      });
    });

    const response = await handleFreeToolTranscriptionRequest(
      uploadRequest(),
      { APP_ENV: "development", GROQ_API_KEY: "local-groq-key" },
      { fetcher },
    );

    expect(response?.status).toBe(200);
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      expect.objectContaining({ method: "POST" }),
    );
    expect(await response?.json()).toMatchObject({
      transcript: "Hello from local Groq.",
      durationSeconds: 1.5,
      wordCount: 4,
    });
  });

  it("uses Workers AI without forwarding audio to Groq when both are configured", async () => {
    const ai = { run: vi.fn().mockResolvedValue(whisperOutput) };
    const fetcher = vi.fn<typeof fetch>();
    const request = uploadRequest();
    const response = await handleFreeToolTranscriptionRequest(
      request,
      {
        APP_ENV: "development",
        AI: ai as unknown as Ai,
        GROQ_API_KEY: "must-not-be-used",
        CLOUDFLARE_AI_GATEWAY_ID: "bento-tools",
      },
      { fetcher },
    );

    expect(response?.status).toBe(200);
    expect(fetcher).not.toHaveBeenCalled();
    expect(ai.run).toHaveBeenCalledWith(
      "@cf/openai/whisper-large-v3-turbo",
      expect.objectContaining({
        audio: Buffer.from(wavBytes()).toString("base64"),
        task: "transcribe",
      }),
      expect.objectContaining({
        signal: request.signal,
        gateway: { id: "bento-tools", collectLog: false, skipCache: true },
      }),
    );
  });

  it("falls back to Groq when Workers AI fails", async () => {
    const ai = { run: vi.fn().mockRejectedValue(new Error("workers unavailable")) };
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        text: "Hello from Groq fallback.",
        language: "en",
        duration: 1.5,
        segments: [{ start: 0, end: 1.5, text: "Hello from Groq fallback." }],
      }),
    );

    const response = await handleFreeToolTranscriptionRequest(
      uploadRequest(),
      { APP_ENV: "development", AI: ai as unknown as Ai, GROQ_API_KEY: "fallback-key" },
      { fetcher },
    );

    expect(response?.status).toBe(200);
    expect(ai.run).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      expect.objectContaining({
        headers: { Authorization: "Bearer fallback-key" },
      }),
    );
    expect(await response?.json()).toMatchObject({ transcript: "Hello from Groq fallback." });
  });

  it("rejects unsupported, spoofed, oversized, mismatched, and cross-origin uploads", async () => {
    const runWhisper = vi.fn().mockResolvedValue(whisperOutput);
    const cases = [
      uploadRequest(wavBytes(), { "content-type": "text/plain" }),
      uploadRequest(new Uint8Array(64)),
      uploadRequest(wavBytes(), { "content-type": "audio/mpeg" }),
      uploadRequest(wavBytes(), { "x-bento-file-size": "63" }),
      uploadRequest(wavBytes(), { "content-length": "63" }),
      uploadRequest(wavBytes(), { origin: "https://attacker.example" }),
      new Request(`http://localhost:8080${TRANSCRIPTION_API_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "audio/wav",
          "content-length": String(MAX_TRANSCRIPTION_BYTES + 1),
        },
        body: wavBytes(),
      }),
    ];

    const responses = await Promise.all(
      cases.map((request) =>
        handleFreeToolTranscriptionRequest(request, { APP_ENV: "development" }, { runWhisper }),
      ),
    );
    expect(responses.map((response) => response?.status)).toEqual([
      415, 415, 415, 400, 400, 403, 413,
    ]);
    expect(runWhisper).not.toHaveBeenCalled();
  });

  it("rejects chunked bodies that cross the upload limit", async () => {
    const first = new Uint8Array(MAX_TRANSCRIPTION_BYTES / 2 + 1);
    first.set(wavBytes(), 0);
    const request = new Request(`http://localhost:8080${TRANSCRIPTION_API_PATH}`, {
      method: "POST",
      headers: { "content-type": "audio/wav", origin: "http://localhost:8080" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(first);
          controller.enqueue(new Uint8Array(MAX_TRANSCRIPTION_BYTES / 2));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const runWhisper = vi.fn();

    const response = await handleFreeToolTranscriptionRequest(
      request,
      { APP_ENV: "development" },
      { runWhisper },
    );

    expect(response?.status).toBe(413);
    expect(runWhisper).not.toHaveBeenCalled();
  });

  it("uses only the dedicated transcription limiter and keys it by client IP", async () => {
    const transcriptionLimit = vi.fn().mockResolvedValue({ success: true });
    const generalAiLimit = vi.fn().mockResolvedValue({ success: false });
    const runWhisper = vi.fn().mockResolvedValue(whisperOutput);
    const env = {
      APP_ENV: "development",
      FREE_TOOLS_TRANSCRIPTION_RATE_LIMITER: { limit: transcriptionLimit },
      FREE_TOOLS_AI_RATE_LIMITER: { limit: generalAiLimit },
    } as Parameters<typeof handleFreeToolTranscriptionRequest>[1] & {
      FREE_TOOLS_AI_RATE_LIMITER: { limit: typeof generalAiLimit };
    };

    const response = await handleFreeToolTranscriptionRequest(
      uploadRequest(wavBytes(), { "cf-connecting-ip": "203.0.113.10" }),
      env,
      { runWhisper },
    );

    expect(response?.status).toBe(200);
    expect(transcriptionLimit).toHaveBeenCalledWith({
      key: "free-tool-transcription:203.0.113.10",
    });
    expect(generalAiLimit).not.toHaveBeenCalled();
  });

  it("requires Turnstile after the production limiter and before transcription", async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });
    const runWhisper = vi.fn();
    const response = await handleFreeToolTranscriptionRequest(
      uploadRequest(),
      {
        APP_ENV: "production",
        FREE_TOOLS_TRANSCRIPTION_RATE_LIMITER: { limit },
        TURNSTILE_VERIFIER_URL: "https://turnstile.example",
      },
      { runWhisper },
    );

    expect(response?.status).toBe(403);
    expect(limit).toHaveBeenCalledOnce();
    expect(runWhisper).not.toHaveBeenCalled();
  });

  it("continues to transcription after valid production Turnstile verification", async () => {
    const verifier = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ success: true, action: TURNSTILE_ACTION, hostname: "localhost" }),
      );
    vi.stubGlobal("fetch", verifier);
    const runWhisper = vi.fn().mockResolvedValue(whisperOutput);
    const response = await handleFreeToolTranscriptionRequest(
      uploadRequest(wavBytes(), {
        "cf-connecting-ip": "203.0.113.21",
        [TURNSTILE_TOKEN_HEADER]: "valid-turnstile-token",
      }),
      {
        APP_ENV: "production",
        FREE_TOOLS_TRANSCRIPTION_RATE_LIMITER: {
          limit: vi.fn().mockResolvedValue({ success: true }),
        },
        TURNSTILE_VERIFIER_URL: "https://turnstile.example",
      },
      { runWhisper },
    );

    expect(response?.status).toBe(200);
    expect(verifier).toHaveBeenCalledOnce();
    expect(runWhisper).toHaveBeenCalledOnce();
  });

  it("fails closed when the dedicated production binding is absent", async () => {
    const generalAiLimit = vi.fn().mockResolvedValue({ success: true });
    const runWhisper = vi.fn();
    const env = {
      APP_ENV: "production",
      FREE_TOOLS_AI_RATE_LIMITER: { limit: generalAiLimit },
    } as unknown as Parameters<typeof handleFreeToolTranscriptionRequest>[1];

    const response = await handleFreeToolTranscriptionRequest(uploadRequest(), env, {
      runWhisper,
    });

    expect(response?.status).toBe(503);
    expect(generalAiLimit).not.toHaveBeenCalled();
    expect(runWhisper).not.toHaveBeenCalled();
  });

  it("fails closed when the dedicated staging binding is absent", async () => {
    const runWhisper = vi.fn();
    const response = await handleFreeToolTranscriptionRequest(
      uploadRequest(),
      { APP_ENV: "staging" },
      { runWhisper },
    );

    expect(response?.status).toBe(503);
    expect(runWhisper).not.toHaveBeenCalled();
  });

  it("returns 429 when the dedicated limiter is exhausted", async () => {
    const runWhisper = vi.fn();
    const response = await handleFreeToolTranscriptionRequest(
      uploadRequest(),
      {
        APP_ENV: "production",
        FREE_TOOLS_TRANSCRIPTION_RATE_LIMITER: {
          limit: vi.fn().mockResolvedValue({ success: false }),
        },
      },
      { runWhisper },
    );

    expect(response?.status).toBe(429);
    expect(response?.headers.get("retry-after")).toBe("60");
    expect(runWhisper).not.toHaveBeenCalled();
  });

  it("fails closed when the dedicated production limiter throws", async () => {
    const runWhisper = vi.fn();
    const response = await handleFreeToolTranscriptionRequest(
      uploadRequest(),
      {
        APP_ENV: "production",
        FREE_TOOLS_TRANSCRIPTION_RATE_LIMITER: {
          limit: vi.fn().mockRejectedValue(new Error("rate limiter unavailable")),
        },
      },
      { runWhisper },
    );

    expect(response?.status).toBe(503);
    expect(runWhisper).not.toHaveBeenCalled();
  });

  it("does not expose provider errors or accept malformed model output", async () => {
    const thrown = await handleFreeToolTranscriptionRequest(
      uploadRequest(),
      { APP_ENV: "development" },
      { runWhisper: vi.fn().mockRejectedValue(new Error("provider secret detail")) },
    );
    expect(thrown?.status).toBe(502);
    expect(await thrown?.text()).not.toContain("provider secret detail");
    expect(normalizeWhisperTranscription({ text: "Hello", segments: [] })).toBeNull();
    expect(
      normalizeWhisperTranscription({ text: "", segments: whisperOutput.segments }),
    ).toBeNull();
  });

  it("recognizes the supported audio container signatures", () => {
    const ftyp = new Uint8Array(32);
    ftyp.set(new TextEncoder().encode("ftyp"), 4);
    const aac = new Uint8Array(32);
    aac.set([0xff, 0xf1]);
    const webm = new Uint8Array(32);
    webm.set([0x1a, 0x45, 0xdf, 0xa3]);
    expect(detectTranscriptionAudioFormat(wavBytes())).toBe("wav");
    expect(detectTranscriptionAudioFormat(new TextEncoder().encode("fLaC audio data"))).toBe(
      "flac",
    );
    expect(detectTranscriptionAudioFormat(new TextEncoder().encode("OggS audio data"))).toBe("ogg");
    expect(detectTranscriptionAudioFormat(ftyp)).toBe("m4a");
    expect(detectTranscriptionAudioFormat(aac)).toBe("aac");
    expect(detectTranscriptionAudioFormat(new TextEncoder().encode("ID3 audio data"))).toBe("mp3");
    expect(detectTranscriptionAudioFormat(webm)).toBe("webm");
  });

  it("only handles its exact route and advertises POST for other methods", async () => {
    await expect(
      handleFreeToolTranscriptionRequest(
        new Request("http://localhost:8080/api/tools/not-transcribe", { method: "POST" }),
        {},
      ),
    ).resolves.toBeNull();

    const response = await handleFreeToolTranscriptionRequest(
      new Request(`http://localhost:8080${TRANSCRIPTION_API_PATH}`, { method: "GET" }),
      {},
    );
    expect(response?.status).toBe(405);
    expect(response?.headers.get("allow")).toBe("POST");
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
  });
});
