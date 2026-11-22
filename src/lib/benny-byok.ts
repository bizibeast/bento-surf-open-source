import { z } from "zod";

export const bennyProviderIdSchema = z.string().uuid();
export const bennyModelSchema = z
  .string()
  .trim()
  .max(180)
  .regex(/^[a-z0-9][a-z0-9_.:/-]*$/i, "Enter a valid model ID.");
export const bennyProviderKeySchema = z
  .string()
  .trim()
  .min(16)
  .max(512)
  .regex(/^[!-~]+$/, "Enter a valid API key.");

export const bennyProviderKindSchema = z.enum(["openrouter", "openai", "compatible"]);
export type BennyProviderKind = z.infer<typeof bennyProviderKindSchema>;
export const bennyProviderKindLabels: Record<BennyProviderKind, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  compatible: "OpenAI-compatible",
};

const endpointFields = {
  kind: bennyProviderKindSchema.optional(),
  baseUrl: z.string().trim().min(1).max(300).optional(),
};

export const bennyProviderInputSchema = z.object({
  id: bennyProviderIdSchema.optional(),
  name: z.string().trim().min(1).max(60),
  model: bennyModelSchema,
  additionalModels: z.array(bennyModelSchema).max(8).optional(),
  apiKey: bennyProviderKeySchema.optional(),
  ...endpointFields,
});

export type BennyProvider = {
  id: string;
  name: string;
  model: string;
  provider_kind?: BennyProviderKind;
  base_url?: string | null;
  additional_models?: string[];
};

export type BennyProviderPreferences = {
  providers: BennyProvider[];
  defaultProviderId: string | null;
};

export type BennyModelOption = {
  id: string;
  name: string;
  jsonMode: boolean;
};

export const bennyProviderCatalogInputSchema = z.union([
  z.object({ apiKey: bennyProviderKeySchema, ...endpointFields }).strict(),
  z.object({ id: bennyProviderIdSchema }).strict(),
]);

export const bennyWebSearchQuerySchema = z
  .string()
  .trim()
  .min(2)
  .max(450)
  .refine((query) => query.split(/\s+/).length <= 70, "Use at most 70 words in the search query.");
