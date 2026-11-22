import { z } from "zod";
import {
  HEYGEN_ENGINE,
  heyGenIdSchema,
  speechWordSchema,
  type HeyGenCatalogInput,
} from "./external-tools";
import { readResponseText } from "./request-security.server";

const origin = "https://api.heygen.com";
// HeyGen's videos:write grant also authorizes videos:read endpoints.
const requiredScopes = ["avatars:read", "voices:read", "videos:write"];

export class HeyGenRequestError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401 || status === 403
        ? "HeyGen could not authorize this action. Check your key and its permissions."
        : status === 404
          ? "The selected resource could not be found in the connected HeyGen account."
          : status === 429
            ? "HeyGen is rate limiting requests. Try again in a moment."
            : "HeyGen could not complete the request.",
    );
  }
}

function dataSchema<T extends z.ZodType>(data: T) {
  return z.object({ data });
}

const lookSchema = z.object({
  id: heyGenIdSchema,
  name: z.string().min(1).max(200),
  avatar_type: z.enum(["photo_avatar", "digital_twin", "studio_avatar"]),
  status: z.string().optional(),
  default_voice_id: heyGenIdSchema.nullish(),
  supported_api_engines: z.array(z.string()).nullish(),
});

const voiceSchema = z.object({
  voice_id: heyGenIdSchema,
  name: z.string().min(1).max(200),
  status: z.string().nullish(),
  language: z.string().max(60).nullish(),
});

function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    data: z.array(item).max(50),
    next_token: z.string().max(1024).nullish(),
  });
}

function availableLook(look: z.infer<typeof lookSchema>) {
  return (
    (!look.status || look.status === "completed") &&
    look.supported_api_engines?.includes(HEYGEN_ENGINE)
  );
}

function avatarOption(look: z.infer<typeof lookSchema>) {
  return {
    id: look.id,
    name: look.name,
    avatarType: look.avatar_type,
    defaultVoiceId: look.default_voice_id ?? null,
    estimatedUsdPerMinute: look.avatar_type === "photo_avatar" ? 2.31 : 4.83,
  };
}

function availableVoice(voice: z.infer<typeof voiceSchema>) {
  return !voice.status || voice.status.toLowerCase() === "active";
}

function voiceOption(voice: z.infer<typeof voiceSchema>) {
  return { id: voice.voice_id, name: voice.name, language: voice.language ?? null };
}

export function createHeyGenClient(key: string, fetcher: typeof fetch = fetch) {
  async function request<T extends z.ZodType>(
    path: string,
    schema: T,
    write?: { body: object; idempotencyKey: string },
  ): Promise<z.output<T>> {
    const signal = AbortSignal.timeout(path === "/v3/models/audio/tts" ? 45_000 : 8_000);
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response;
      try {
        response = await fetcher(new URL(path, origin), {
          method: write ? "POST" : "GET",
          headers: {
            "x-api-key": key,
            accept: "application/json",
            ...(write && {
              "content-type": "application/json",
              "idempotency-key": write.idempotencyKey,
            }),
          },
          body: write ? JSON.stringify(write.body) : undefined,
          redirect: "manual",
          signal,
        });
      } catch {
        throw new HeyGenRequestError(0);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (!write && attempt === 0 && [502, 503, 504].includes(response.status)) continue;
        throw new HeyGenRequestError(response.status);
      }
      try {
        return schema.parse(JSON.parse(await readResponseText(response, 512_000)));
      } catch {
        throw new HeyGenRequestError(0);
      }
    }
    throw new HeyGenRequestError(0);
  }

  function catalogPath(path: string, scopeField: string, input: HeyGenCatalogInput) {
    const query = new URLSearchParams({ [scopeField]: input.scope, limit: "20" });
    if (input.token) query.set("token", input.token);
    return `${path}?${query}`;
  }

  return {
    async voice(voiceId: string) {
      const { data } = await request(
        `/v3/models/audio/voices/${heyGenIdSchema.parse(voiceId)}`,
        dataSchema(voiceSchema),
      );
      if (data.voice_id !== voiceId || !availableVoice(data)) throw new HeyGenRequestError(404);
      return voiceOption(data);
    },
    async speech(input: { jobId: string; voiceId: string; script: string }) {
      const { data } = await request(
        "/v3/models/audio/tts",
        dataSchema(
          z.object({
            audio_url: z.string().max(4096),
            duration: z.number().positive().max(90),
            original_words: z
              .array(
                z
                  .object({ text: z.string(), start_time: z.number(), end_time: z.number() })
                  .transform((word) =>
                    speechWordSchema.parse({
                      word: word.text,
                      start: word.start_time,
                      end: word.end_time,
                    }),
                  ),
              )
              .max(1000)
              .nullish(),
          }),
        ),
        {
          idempotencyKey: input.jobId,
          body: {
            voice_id: input.voiceId,
            text: input.script,
            model: "heygen-voice-1",
            with_timestamps: true,
          },
        },
      );
      return data;
    },
    async verifyCredential(options?: { allowFullAccess?: boolean }) {
      const result = await request(
        "/v3/api_keys/self",
        dataSchema(
          z.object({
            status: z.string(),
            scope_mode: z.string(),
            scopes: z.array(z.string()).nullish(),
          }),
        ),
      );
      const custom =
        result.data.scope_mode === "custom" &&
        requiredScopes.every((scope) => result.data.scopes?.includes(scope));
      // Only the server-side managed-account commissioner opts in. Creator BYOK
      // connections continue requiring the documented custom scopes by default.
      const managedFullAccess = options?.allowFullAccess && result.data.scope_mode === "full";
      if (result.data.status !== "active" || (!custom && !managedFullAccess)) {
        const reason =
          result.data.status !== "active"
            ? "The key is inactive."
            : result.data.scope_mode !== "custom"
              ? "Set the key's scope mode to custom."
              : `Missing scopes: ${requiredScopes.filter((scope) => !result.data.scopes?.includes(scope)).join(", ")}.`;
        throw new Error(
          `Use an active scoped HeyGen key with avatars:read, voices:read and videos:write. ${reason}`,
        );
      }
    },
    async avatars(input: HeyGenCatalogInput) {
      const result = await request(
        catalogPath("/v3/avatars/looks", "ownership", input),
        pageSchema(lookSchema),
      );
      return {
        avatars: result.data.filter(availableLook).map(avatarOption),
        nextToken: result.next_token ?? null,
      };
    },
    async voices(input: HeyGenCatalogInput) {
      const result = await request(
        catalogPath("/v3/models/audio/voices", "type", input),
        pageSchema(voiceSchema),
      );
      return {
        voices: result.data.filter(availableVoice).map(voiceOption),
        nextToken: result.next_token ?? null,
      };
    },
    async selection(avatarId: string, voiceId: string) {
      const [avatar, voice] = await Promise.all([
        request(`/v3/avatars/looks/${heyGenIdSchema.parse(avatarId)}`, dataSchema(lookSchema)),
        request(
          `/v3/models/audio/voices/${heyGenIdSchema.parse(voiceId)}`,
          dataSchema(voiceSchema),
        ),
      ]);
      if (!availableLook(avatar.data) || !availableVoice(voice.data)) {
        throw new Error("Choose a ready HeyGen avatar and active voice that support Avatar IV.");
      }
      if (avatar.data.id !== avatarId || voice.data.voice_id !== voiceId) {
        throw new Error("HeyGen returned a different avatar or voice than requested.");
      }
      return { avatar: avatarOption(avatar.data), voice: voiceOption(voice.data) };
    },
    async submit(input: {
      jobId: string;
      avatarId: string;
      voiceId: string;
      script: string;
      audioUrl?: string;
    }) {
      const { data } = await request(
        "/v3/videos",
        dataSchema(z.object({ video_id: heyGenIdSchema })),
        {
          idempotencyKey: input.jobId,
          body: {
            type: "avatar",
            title: `Bento ${input.jobId}`,
            avatar_id: input.avatarId,
            ...(input.audioUrl
              ? { audio_url: input.audioUrl }
              : { voice_id: input.voiceId, script: input.script }),
            engine: { type: HEYGEN_ENGINE },
            aspect_ratio: "9:16",
            resolution: "720p",
            output_format: "mp4",
          },
        },
      );
      return data.video_id;
    },
    async status(videoId: string) {
      const { data } = await request(
        `/v3/videos/${heyGenIdSchema.parse(videoId)}`,
        dataSchema(
          z.object({
            id: heyGenIdSchema,
            status: z.enum(["pending", "processing", "completed", "failed"]),
            duration: z.number().positive().nullish(),
            video_url: z.string().max(4096).nullish(),
          }),
        ),
      );
      if (data.id !== videoId) throw new HeyGenRequestError(0);
      return data;
    },
  };
}

export function validatedHeyGenAssetUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      ["files.heygen.ai", "files2.heygen.ai", "resource.heygen.ai", "resource2.heygen.ai"].includes(
        url.hostname,
      ) &&
      !url.username &&
      !url.password &&
      !url.port
      ? url
      : null;
  } catch {
    return null;
  }
}
