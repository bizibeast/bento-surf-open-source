import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { z } from "zod";
import {
  bennyModelSchema,
  bennyProviderInputSchema,
  bennyProviderKindLabels,
  type BennyProviderKind,
  type BennyModelOption,
  type BennyProviderPreferences,
} from "./benny-byok";
import { AiStructuredOutputError, type AiProviderTransport } from "./ai-json.server";
import { requireContentWorkspace } from "./content-access.server";
import { hasPlanEntitlement } from "./plan.server";
import { readResponseText } from "./request-security.server";
import {
  decryptServerSecret,
  encryptServerSecret,
  isServerSecretEncryptionKeyValid,
} from "./secret-crypto.server";

export type BennyProviderScope = { workspaceId: string; authUserId: string };
const fixedEndpoints = {
  openrouter: "https://openrouter.ai/api/v1/",
  openai: "https://api.openai.com/v1/",
} as const;
const providerColumns = "id,name,model,provider_kind,base_url,additional_models" as const;

type ProviderTarget = { kind: BennyProviderKind; url: string };
const openRouter: ProviderTarget = { kind: "openrouter", url: fixedEndpoints.openrouter };

function canonicalCompatibleEndpoint(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !url.hostname.includes(".") ||
    url.hostname.endsWith(".") ||
    /^[\d.]+$/.test(url.hostname) ||
    /(?:^|\.)(?:local|internal|localhost|test|onion|arpa)$/.test(url.hostname) ||
    !/^\/[a-z0-9/_-]*$/i.test(url.pathname)
  )
    return null;
  return url.origin + url.pathname.replace(/\/+$/, "") + "/";
}

export function bennyProviderTarget(
  kind: BennyProviderKind,
  baseUrl?: string | null,
): ProviderTarget {
  if (kind !== "compatible") return { kind, url: fixedEndpoints[kind] };
  const url = baseUrl ? canonicalCompatibleEndpoint(baseUrl) : null;
  // Only operator-approved, trusted reverse proxies are eligible. End users
  // cannot use the Worker to fetch destinations of their choice.
  const allowed = (process.env.BENNY_BYOK_CUSTOM_BASE_URLS || "")
    .split(",")
    .map((value) => canonicalCompatibleEndpoint(value.trim()));
  if (!url || !allowed.includes(url)) {
    throw new Error("Choose an HTTPS API base URL approved for this Bento deployment.");
  }
  return { kind, url };
}
const MAX_COMPLETIONS_PER_TURN = 8;

export async function canUseBennyByok(workspaceId: string) {
  const workspaces = process.env.BENNY_BYOK_WORKSPACES?.trim();
  return (
    process.env.BENNY_BYOK_ENABLED === "true" &&
    Boolean(workspaces === "*" || workspaces?.split(",").some((id) => id.trim() === workspaceId)) &&
    isServerSecretEncryptionKeyValid(process.env.BENNY_BYOK_ENCRYPTION_KEY) &&
    (await hasPlanEntitlement(workspaceId, "bennyByok"))
  );
}

export async function requireBennyChatAccess(workspaceId: string) {
  if (!(await canUseBennyByok(workspaceId))) await requireContentWorkspace(workspaceId);
}

const providerError = (target: ProviderTarget, status?: number) => {
  const label = bennyProviderKindLabels[target.kind];
  if (status === 401 || status === 403)
    return new Error(`${label} rejected the connection. Check your key and model permissions.`);
  if (status === 402 || status === 429)
    return new Error(`${label} declined the request. Check your credits and rate limits.`);
  if (status === 400 || status === 404)
    return new Error(
      `${label} could not use this model or request. Check the model ID or try a shorter message.`,
    );
  return new Error(`${label} could not finish the request. Check your connection and try again.`);
};

async function providerRequest(
  target: ProviderTarget,
  path: "key" | "models" | "chat/completions",
  apiKey: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
  body?: string,
) {
  let response: Response;
  try {
    response = await fetcher(new URL(path, target.url), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body,
      redirect: "error",
      signal,
    });
  } catch {
    signal.throwIfAborted();
    throw providerError(target);
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw providerError(target, response.status);
  }
  return response;
}

async function readProviderJson(
  target: ProviderTarget,
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  try {
    return JSON.parse(await readResponseText(response, maxBytes));
  } catch {
    void response.body?.cancel().catch(() => undefined);
    signal.throwIfAborted();
    throw providerError(target);
  }
}

export async function checkBennyOpenRouterKey(apiKey: string, fetcher: typeof fetch = fetch) {
  const response = await providerRequest(
    openRouter,
    "key",
    apiKey,
    AbortSignal.timeout(8_000),
    fetcher,
  );
  void response.body?.cancel().catch(() => undefined);
}

const catalogEntry = z.object({
  id: bennyModelSchema,
  name: z.string().max(180),
  supported_parameters: z.array(z.string()).optional(),
  architecture: z.object({
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
  }),
});
const catalogEnvelope = z.object({ data: z.array(z.unknown()).max(5_000) });

export async function discoverBennyModels(
  apiKey: string,
  fetcher: typeof fetch = fetch,
  target: ProviderTarget = openRouter,
): Promise<BennyModelOption[]> {
  if (target.kind === "openrouter") await checkBennyOpenRouterKey(apiKey, fetcher);
  const signal = AbortSignal.timeout(8_000);
  const response = await providerRequest(target, "models", apiKey, signal, fetcher);
  const decoded = catalogEnvelope.safeParse(
    await readProviderJson(target, response, 4 * 1024 * 1024, signal),
  );
  if (!decoded.success) throw providerError(target);
  if (target.kind !== "openrouter") {
    return decoded.data.data.flatMap((entry) => {
      const parsed = z.object({ id: bennyModelSchema }).safeParse(entry);
      if (!parsed.success || parsed.data.id.includes(apiKey)) return [];
      return [{ id: parsed.data.id, name: parsed.data.id, jsonMode: false }];
    });
  }
  return decoded.data.data.flatMap((entry) => {
    const parsed = catalogEntry.safeParse(entry);
    if (!parsed.success) return [];
    const model = parsed.data;
    if (model.id.includes(apiKey) || model.name.includes(apiKey)) return [];
    if (
      !model.architecture.input_modalities.includes("text") ||
      !model.architecture.output_modalities.includes("text")
    )
      return [];
    return [
      {
        id: model.id,
        name: model.name,
        jsonMode:
          model.supported_parameters?.includes("response_format") === true ||
          model.supported_parameters?.includes("structured_outputs") === true,
      },
    ];
  });
}

export function createBennyOpenRouterTransport(
  apiKey: string,
  model: string,
  fetcher: typeof fetch = fetch,
): AiProviderTransport {
  return createBennyProviderTransport(openRouter, apiKey, model, fetcher);
}

export function createBennyProviderTransport(
  target: ProviderTarget,
  apiKey: string,
  model: string,
  fetcher: typeof fetch = fetch,
): AiProviderTransport {
  let attempts = 0;
  return async (request) => {
    if (request.publicTool) throw providerError(target);
    const signal = AbortSignal.any([
      AbortSignal.timeout(Math.max(1, Math.min(request.timeoutMs ?? 25_000, 25_000))),
      ...(request.signal ? [request.signal] : []),
    ]);
    signal.throwIfAborted();
    if (++attempts > MAX_COMPLETIONS_PER_TURN)
      throw new Error("This Benny turn reached its provider request limit. Try a smaller request.");
    const body = JSON.stringify({
      model,
      messages: request.messages,
      ...(target.kind === "openai"
        ? { max_completion_tokens: request.maxTokens }
        : { max_tokens: request.maxTokens }),
      ...(target.kind === "openrouter"
        ? { provider: { allow_fallbacks: false, require_parameters: true } }
        : {}),
    });
    if (body.includes(apiKey))
      throw new Error("Remove your API key from the chat context before sending.");
    if (new TextEncoder().encode(body).byteLength > 128_000)
      throw new Error("This Benny request is too large. Shorten the prompt or start a new chat.");
    const response = await providerRequest(
      target,
      "chat/completions",
      apiKey,
      signal,
      fetcher,
      body,
    );
    const output = await readProviderJson(target, response, 128 * 1024, signal);
    // Keep provider-supplied errors and raw response metadata out of chat and logs.
    const sanitized = z
      .object({
        choices: z
          .array(z.object({ message: z.object({ content: z.string() }) }))
          .min(1)
          .max(1),
      })
      .safeParse(output);
    if (!sanitized.success) throw new AiStructuredOutputError();
    if (sanitized.data.choices[0]!.message.content.includes(apiKey))
      throw new AiStructuredOutputError();
    return { response: sanitized.data, provider: target.kind };
  };
}

export async function loadBennyProviderPreferences(
  scope: BennyProviderScope,
): Promise<BennyProviderPreferences> {
  const [providers, current] = await Promise.all([
    supabaseAdmin
      .from("benny_ai_providers")
      .select(providerColumns)
      .eq("workspace_id", scope.workspaceId)
      .eq("owner_id", scope.authUserId)
      .order("created_at")
      .order("id"),
    supabaseAdmin
      .from("benny_ai_provider_defaults")
      .select("provider_id")
      .eq("workspace_id", scope.workspaceId)
      .eq("owner_id", scope.authUserId)
      .maybeSingle(),
  ]);
  if (providers.error || current.error) throw new Error("Your Benny providers could not load.");
  return { providers: providers.data, defaultProviderId: current.data?.provider_id ?? null };
}

async function loadOwnedProvider(scope: BennyProviderScope, id: string) {
  const { data, error } = await supabaseAdmin
    .from("benny_ai_providers")
    .select("model,encrypted_api_key,provider_kind,base_url,additional_models")
    .eq("workspace_id", scope.workspaceId)
    .eq("owner_id", scope.authUserId)
    .eq("id", id)
    .maybeSingle();
  if (error || !data)
    throw new Error("This Benny provider is unavailable. Choose a saved connection.");
  return data;
}

async function readBennyApiKey(value: string) {
  try {
    return await decryptServerSecret(value, "benny-byok");
  } catch {
    throw new Error("The provider key could not be read. Replace it in Benny settings.");
  }
}

export async function bennyInferenceForProvider(
  scope: BennyProviderScope,
  id: string,
  model?: string,
) {
  const row = await loadOwnedProvider(scope, id);
  if (model && model !== row.model && !row.additional_models?.includes(model)) {
    throw new Error("Choose a saved model for this provider.");
  }
  const target = bennyProviderTarget(row.provider_kind ?? "openrouter", row.base_url);
  return createBennyProviderTransport(
    target,
    await readBennyApiKey(row.encrypted_api_key),
    model ?? row.model,
  );
}

export async function discoverSavedBennyModels(scope: BennyProviderScope, id: string) {
  const row = await loadOwnedProvider(scope, id);
  const target = bennyProviderTarget(row.provider_kind ?? "openrouter", row.base_url);
  return discoverBennyModels(await readBennyApiKey(row.encrypted_api_key), fetch, target);
}

export async function saveBennyProvider(
  scope: BennyProviderScope,
  input: z.infer<typeof bennyProviderInputSchema>,
) {
  const owned = input.id ? await loadOwnedProvider(scope, input.id) : null;
  const kind = input.kind ?? owned?.provider_kind ?? "openrouter";
  const target = bennyProviderTarget(kind, input.baseUrl ?? owned?.base_url);
  const key = input.apiKey;
  const models = [...new Set(input.additionalModels ?? owned?.additional_models ?? [])].filter(
    (model) => model !== input.model,
  );
  const oldKey = owned ? await readBennyApiKey(owned.encrypted_api_key).catch(() => null) : null;
  if (
    [key, oldKey].some(
      (secret) =>
        secret &&
        [input.name, input.model, target.url, ...models].some((value) => value.includes(secret)),
    )
  ) {
    throw new Error("Use the password field for your provider key.");
  }
  if (
    !key &&
    (!owned ||
      kind !== owned.provider_kind ||
      (kind === "compatible" && target.url !== owned.base_url))
  ) {
    throw new Error("Enter a new key for this provider endpoint.");
  }
  if (key) {
    if (target.kind === "openrouter") await checkBennyOpenRouterKey(key);
    else if (target.kind === "openai") await discoverBennyModels(key, fetch, target);
  }
  const values = {
    name: input.name,
    model: input.model,
    provider_kind: target.kind,
    base_url: target.kind === "compatible" ? target.url : null,
    additional_models: models,
  };
  const result = input.id
    ? await supabaseAdmin
        .from("benny_ai_providers")
        .update({
          ...values,
          ...(key ? { encrypted_api_key: await encryptServerSecret(key, "benny-byok") } : {}),
        })
        .eq("workspace_id", scope.workspaceId)
        .eq("owner_id", scope.authUserId)
        .eq("id", input.id)
        .select(providerColumns)
        .maybeSingle()
    : await supabaseAdmin
        .from("benny_ai_providers")
        .insert({
          ...values,
          workspace_id: scope.workspaceId,
          owner_id: scope.authUserId,
          encrypted_api_key: await encryptServerSecret(key!, "benny-byok"),
        })
        .select(providerColumns)
        .single();
  if (result.error || !result.data) throw new Error("Your Benny provider could not be saved.");
  return result.data;
}

export async function deleteBennyProvider(scope: BennyProviderScope, id: string) {
  const { error } = await supabaseAdmin
    .from("benny_ai_providers")
    .delete()
    .eq("workspace_id", scope.workspaceId)
    .eq("owner_id", scope.authUserId)
    .eq("id", id);
  if (error) throw new Error("Your Benny provider could not be removed.");
}

export async function setBennyDefaultProvider(scope: BennyProviderScope, id: string | null) {
  const { error } = id
    ? await supabaseAdmin.from("benny_ai_provider_defaults").upsert({
        workspace_id: scope.workspaceId,
        owner_id: scope.authUserId,
        provider_id: id,
      })
    : await supabaseAdmin
        .from("benny_ai_provider_defaults")
        .delete()
        .eq("workspace_id", scope.workspaceId)
        .eq("owner_id", scope.authUserId);
  if (error) throw new Error("Your Benny default could not be saved. Choose a saved connection.");
}
