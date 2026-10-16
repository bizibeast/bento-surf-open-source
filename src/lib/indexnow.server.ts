import { PRODUCTION_PUBLIC_ORIGIN, normalizeOrigin } from "./application-urls";

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const ARTICLE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const INDEXNOW_KEY_PATTERN = /^[A-Za-z0-9-]{8,128}$/;

export type IndexNowEnv = {
  APP_ENV?: string;
  INDEXNOW_KEY?: string;
  VITE_PUBLIC_URL?: string;
};

type SeoArticleUrl = { slug: string; status: string };

function publicOrigin(env: IndexNowEnv | undefined) {
  return normalizeOrigin(env?.VITE_PUBLIC_URL, PRODUCTION_PUBLIC_ORIGIN);
}

export function readIndexNowKey(env: IndexNowEnv | undefined) {
  const key = env?.INDEXNOW_KEY?.trim();
  return key && INDEXNOW_KEY_PATTERN.test(key) ? key : undefined;
}

export function indexNowKeyResponse(request: Request, env: IndexNowEnv | undefined) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const key = readIndexNowKey(env);
  if (!key) return null;
  const url = new URL(request.url);
  if (url.pathname !== `/${key}.txt`) return null;
  const host = new URL(publicOrigin(env)).hostname;
  if (url.hostname.toLowerCase() !== host) return null;
  return new Response(request.method === "HEAD" ? null : key, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

export function indexNowUrlsForSeoArticle(
  origin: string,
  before: SeoArticleUrl | null,
  after: SeoArticleUrl,
) {
  const base = origin.replace(/\/$/, "");
  const urlFor = (row: SeoArticleUrl | null) =>
    row?.status === "published" && ARTICLE_SLUG.test(row.slug) ? `${base}/blog/${row.slug}` : null;
  const current = urlFor(after);
  const previous = before && before.slug !== after.slug ? urlFor(before) : null;
  return [...new Set([current, previous].filter((url): url is string => Boolean(url)))];
}

export async function notifyIndexNow(
  urls: readonly string[],
  env: IndexNowEnv | undefined,
  fetchImpl: typeof fetch = fetch,
) {
  const origin = publicOrigin(env);
  const key = readIndexNowKey(env);
  if (env?.APP_ENV !== "production" || !env?.VITE_PUBLIC_URL || !origin.startsWith("https://") || !key) {
    return { submitted: [] as string[] };
  }
  const host = new URL(origin).hostname;
  const urlList = [
    ...new Set(
      urls.filter((url) => {
        try {
          return new URL(url).hostname === host;
        } catch {
          return false;
        }
      }),
    ),
  ];
  if (!urlList.length) return { submitted: [] as string[] };
  try {
    const response = await fetchImpl(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host,
        key,
        keyLocation: `${origin}/${key}.txt`,
        urlList,
      }),
    });
    if (!response.ok) {
      console.error("[indexnow] notification failed", response.status);
      return { submitted: [] as string[] };
    }
    return { submitted: urlList };
  } catch (error) {
    console.error(
      "[indexnow] notification failed",
      error instanceof Error ? error.message : "request failed",
    );
    return { submitted: [] as string[] };
  }
}

export function notifyPublishedSeoArticle(
  input: { before: SeoArticleUrl | null; after: SeoArticleUrl },
  env: IndexNowEnv | undefined,
  fetchImpl: typeof fetch = fetch,
) {
  return notifyIndexNow(
    indexNowUrlsForSeoArticle(publicOrigin(env), input.before, input.after),
    env,
    fetchImpl,
  );
}
