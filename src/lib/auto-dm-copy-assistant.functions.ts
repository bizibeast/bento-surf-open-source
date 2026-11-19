import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePlanEntitlement } from "./plan.server";
import { enforceRequestRateLimit, readResponseText } from "./request-security.server";
import { reserveAiProviderUsage, settleProviderUsage } from "./provider-budget.server";

const inputSchema = z.object({
  platform: z.enum(["instagram", "facebook"]),
  kind: z.enum(["opening", "reply", "email", "follow", "public"]),
  source: z.string().trim().min(5).max(1000),
});

export function parseSuggestions(response: unknown, source: string, maxLength: number): string[] {
  const content = (response as { choices?: Array<{ message?: { content?: unknown } }> })
    ?.choices?.[0]?.message?.content;
  if (typeof content !== "string")
    throw new Error("The free model did not return text suggestions.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw new Error("The free model did not return usable text suggestions.");
  }
  const result = z.object({ alternatives: z.array(z.string()).length(2) }).safeParse(parsed);
  if (!result.success) throw new Error("The free model did not return two suggestions.");
  const alternatives = result.data.alternatives.map((item) =>
    maxLength === 300 ? item.replace(/\s+/g, " ").trim() : item.trim(),
  );
  if (
    alternatives.some(
      (item) => !item || item.length > maxLength || /(?:https?:\/\/|www\.)\S+/i.test(item),
    ) ||
    new Set([source.toLocaleLowerCase(), ...alternatives.map((item) => item.toLocaleLowerCase())])
      .size !== 3
  ) {
    throw new Error("The suggestions need review. Please write the alternatives yourself.");
  }
  return alternatives;
}

export const suggestMetaAutoDmAlternatives = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => inputSchema.parse(input))
  .handler(async ({ data, context }) => {
    await requirePlanEntitlement(
      context.userId,
      data.platform === "instagram" ? "instagramAutoDM" : "facebookAutoDM",
      "Auto-DM access is required to draft message alternatives.",
    );
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "meta-auto-dm-copy-assistant",
      context.userId,
    );
    if (/(?:https?:\/\/|www\.)\S+/i.test(data.source)) {
      throw new Error("Put the destination link in the button field before drafting alternatives.");
    }
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) throw new Error("The OpenRouter copy assistant is not configured.");
    // The free router plus a zero price ceiling prevents a paid model fallback.
    const reservation = await reserveAiProviderUsage(1, {
      provider: "openrouter",
      model: "openrouter/free",
      workspaceId: context.userId,
    });
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(process.env.VITE_APP_URL?.trim()
          ? { "HTTP-Referer": process.env.VITE_APP_URL.trim() }
          : {}),
        "X-OpenRouter-Title": process.env.VITE_APP_NAME?.trim() || "Bento Surf",
      },
      body: JSON.stringify({
        model: "openrouter/free",
        temperature: 0.5,
        max_tokens: 900,
        provider: { max_price: { prompt: 0, completion: 0 } },
        messages: [
          {
            role: "system",
            content:
              'Draft two distinct, concise alternatives for a creator-written automated Facebook or Instagram reply. Preserve the exact meaning, promise, call to action, language, and any disclosure of automation. Do not add links, claims, urgency, or a false impression of human authorship. Return only JSON: {"alternatives":["...","..."]}.',
          },
          { role: "user", content: `Message type: ${data.kind}. Original: ${data.source}` },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error("The OpenRouter free model is unavailable right now.");
    const raw = await readResponseText(response, 16 * 1024);
    const value = JSON.parse(raw);
    const providerCost = value?.usage?.cost;
    if (typeof providerCost === "number" && providerCost > 0) {
      await settleProviderUsage(reservation, Math.ceil(providerCost * 1_000_000));
      throw new Error("The provider returned a priced result; suggestions were discarded.");
    }
    await settleProviderUsage(reservation, 0);
    return {
      alternatives: parseSuggestions(
        value,
        data.source,
        data.kind === "public" ? 300 : ["opening", "reply"].includes(data.kind) ? 1000 : 700,
      ),
    };
  });
