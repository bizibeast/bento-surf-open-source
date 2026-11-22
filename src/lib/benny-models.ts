/** Verified against the provider catalog on 2026-11-22. Prices are reservation
 * ceilings in USD per million tokens, including long-context/cache-write rates. */
export const BENNY_EDITING_MODELS = [
  {
    available: true,
    id: "openai/gpt-6.1-sol",
    name: "GPT 6.1 Sol",
    price: { input: 5, output: 15 },
  },
  {
    available: true,
    id: "openai/gpt-6.2-sol",
    name: "GPT 6.2 Sol",
    price: { input: 5, output: 15 },
  },
  {
    available: true,
    id: "anthropic/claude-opus-5.5",
    name: "Opus 5.5",
    price: { input: 8, output: 20 },
  },
  {
    available: true,
    id: "anthropic/claude-fable-5.2",
    name: "Fable 5.2",
    price: { input: 16, output: 40 },
  },
  {
    available: true,
    id: "openai/gpt-6.2-astra",
    name: "GPT 6.2 Astra",
    price: { input: 20, output: 60 },
  },
  {
    available: true,
    id: "google/gemini-4-hydrogen",
    name: "Gemini 4 Hydrogen",
    price: { input: 1.5, output: 7.5 },
  },
  {
    available: false,
    id: "google/gemini-4-carbon",
    name: "Gemini 4 Carbon",
    price: { input: 2, output: 10 },
  },
  {
    available: true,
    id: "google/gemini-4-argon",
    name: "Gemini 4 Argon",
    price: { input: 2, output: 10 },
  },
  {
    available: false,
    id: "google/gemini-4-neon",
    name: "Gemini 4 Neon",
    price: { input: 3, output: 15 },
  },
] as const;
export type BennyEditingModelId = (typeof BENNY_EDITING_MODELS)[number]["id"];
export type BentoModelOption = { id: string; name: string; available?: boolean };

export function isBennyEditingModel(id: string): id is BennyEditingModelId {
  return BENNY_EDITING_MODELS.some((model) => model.id === id && model.available);
}

export function bennyModelName(id: string): string {
  return (
    BENNY_EDITING_MODELS.find((model) => model.id === id || model.id.split("/")[1] === id)?.name ??
    (
      {
        "z-ai/glm-5.3-flash": "GLM 5.3 Flash",
        "@cf/openai/gpt-oss-20b": "GPT OSS 20B",
        "@cf/openai/gpt-oss-120b": "GPT OSS 120B",
        "openai/gpt-oss-20b": "GPT OSS 20B",
        "openai/gpt-oss-120b": "GPT OSS 120B",
      } as Record<string, string>
    )[id] ??
    id
  );
}

type ModelSettings = {
  bentoModels: BentoModelOption[];
  defaultProviderId: string | null;
  providers: { id: string; model: string; additional_models?: string[] | null }[];
};

/** The legacy Bento route has no override. Named managed routes always carry
 * their exact model ID; saved external accounts keep their own credentials. */
export function bennyModelSelection(settings: ModelSettings | null | undefined, override?: string) {
  const bentoModels = settings?.bentoModels ?? [];
  const encode = (id: string) => (id === "bento" ? "bento" : `bento|${id}`);
  const choice =
    override ?? settings?.defaultProviderId ?? (bentoModels[0] ? encode(bentoModels[0].id) : "");
  const [providerId, model] = choice.split("|", 2);
  const provider = settings?.providers.find(
    (item) =>
      item.id === providerId &&
      (!model || model === item.model || item.additional_models?.includes(model)),
  );
  const bento = bentoModels.find((item) => encode(item.id) === choice && item.available !== false);
  return {
    choice,
    valid: Boolean(provider || bento),
    provider,
    bento,
    input: provider
      ? { aiProviderId: provider.id, ...(model ? { aiModel: model } : {}) }
      : bento && bento.id !== "bento"
        ? { aiModel: bento.id }
        : {},
    options: [
      ...bentoModels.map((item) => ({
        value: encode(item.id),
        label: item.name,
        ...(item.available === false ? { disabled: true } : {}),
      })),
      ...(settings?.providers ?? []).flatMap((item) => [
        { value: item.id, label: `${bennyModelName(item.model)} · Your key` },
        ...(item.additional_models ?? []).map((id) => ({
          value: `${item.id}|${id}`,
          label: `${bennyModelName(id)} · Your key`,
        })),
      ]),
    ],
  };
}
