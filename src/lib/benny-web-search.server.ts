import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { BennyProviderScope } from "./benny-byok.server";
import { scrubProviderText } from "./content-connections";
import { readResponseText } from "./request-security.server";
import { decryptServerSecret, encryptServerSecret } from "./secret-crypto.server";

const BRAVE_SEARCH = "https://api.search.brave.com/res/v1/web/search";
const MAX_RESULTS = 5;
const resultSchema = z.object({
  title: z.string().max(1000),
  url: z.url(),
  description: z.string().max(10_000),
  page_age: z.iso.datetime({ offset: true }).nullish(),
});
const envelope = z.object({
  web: z.object({ results: z.array(z.unknown()).max(25) }).nullish(),
});

export type BennyWebEvidence = {
  id: string;
  title: string;
  summary: string;
  sourceUrl: string;
  sourceName: string;
  sourcePublishedAt: null;
  pageDate: string | null;
  sourceRetrievedAt: string;
  evidenceType: "search_snippet";
};

function scopedSearchCredential(scope: BennyProviderScope) {
  return { workspace_id: scope.workspaceId, owner_id: scope.authUserId };
}

export async function hasBennySearchKey(scope: BennyProviderScope) {
  const { data, error } = await supabaseAdmin
    .from("benny_search_credentials")
    .select("owner_id")
    .match(scopedSearchCredential(scope))
    .maybeSingle();
  if (error) throw new Error("Your web search connection could not load.");
  return Boolean(data);
}

export async function setBennySearchKey(scope: BennyProviderScope, key: string | null) {
  const owner = scopedSearchCredential(scope);
  const result = key
    ? await supabaseAdmin.from("benny_search_credentials").upsert({
        ...owner,
        encrypted_api_key: await encryptServerSecret(key, "benny-byok"),
      })
    : await supabaseAdmin.from("benny_search_credentials").delete().match(owner);
  if (result.error) throw new Error("Your web search connection could not be saved.");
}

export async function readBennySearchKey(scope: BennyProviderScope) {
  const { data, error } = await supabaseAdmin
    .from("benny_search_credentials")
    .select("encrypted_api_key")
    .match(scopedSearchCredential(scope))
    .maybeSingle();
  if (error || !data) throw new Error("Connect your Brave Search API key in Benny settings.");
  try {
    return await decryptServerSecret(data.encrypted_api_key, "benny-byok");
  } catch {
    throw new Error("The Brave key could not be read. Replace it in Benny settings.");
  }
}

function plainSnippet(text: string, maxLength: number) {
  return scrubProviderText(
    text
      .replace(/<\/?[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  ).slice(0, maxLength);
}

export async function searchBennyWeb(
  query: string,
  key: string,
  fetcher: typeof fetch = fetch,
): Promise<BennyWebEvidence[]> {
  if (
    !query ||
    query.includes(key) ||
    scrubProviderText(query) !== query ||
    /\bsk-(?:or|proj|live|test)-[\w-]+/.test(query)
  ) {
    throw new Error("Enter a public search query without credentials.");
  }
  const url = new URL(BRAVE_SEARCH);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(MAX_RESULTS));
  url.searchParams.set("result_filter", "web");
  url.searchParams.set("text_decorations", "false");
  const signal = AbortSignal.timeout(9_000);
  let payload: unknown;
  try {
    const response = await fetcher(url, {
      headers: { Accept: "application/json", "X-Subscription-Token": key },
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("Search rejected.");
    }
    payload = JSON.parse(await readResponseText(response, 256 * 1024));
  } catch {
    throw new Error("Brave Search could not finish. Check the key, credits, and rate limits.");
  }
  const parsed = envelope.safeParse(payload);
  if (!parsed.success) throw new Error("Brave Search returned an invalid result.");

  const seen = new Set<string>();
  const retrievedAt = new Date().toISOString();
  return (parsed.data.web?.results ?? []).slice(0, MAX_RESULTS).flatMap((row, index) => {
    const parsed = resultSchema.safeParse(row);
    if (!parsed.success) return [];
    const raw = parsed.data;
    if ([raw.title, raw.url, raw.description, raw.page_age].some((value) => value?.includes(key)))
      return [];
    const url = new URL(raw.url);
    if (url.protocol !== "https:" || url.username || url.password) return [];
    url.hash = "";
    if (seen.has(url.href)) return [];
    seen.add(url.href);
    const title = plainSnippet(raw.title, 180);
    const summary = plainSnippet(raw.description, 950);
    if (!title || !summary) return [];
    return [
      {
        id: `brave-${index + 1}`,
        title,
        summary,
        sourceUrl: url.href,
        sourceName: url.hostname,
        sourcePublishedAt: null,
        pageDate: raw.page_age && Date.parse(raw.page_age) <= Date.now() ? raw.page_age : null,
        sourceRetrievedAt: retrievedAt,
        evidenceType: "search_snippet" as const,
      },
    ];
  });
}
