import { normalizePublicPostUrl, type PublicPostMetric } from "./public-post-stats";
import { discoverPostKey } from "./content-discover-identity";
import { publicPostCountEvidence, observedCount } from "./content-source-enrichment";
import { extractPublicPostPage } from "./public-post-browser-page";
import { withPublicPostBrowserBudget } from "./social-preview-reliability.server";
import { parsePublicHttpUrl } from "./safe-url";

const hosts = [
  "instagram.com",
  "cdninstagram.com",
  "facebook.com",
  "facebook.net",
  "fbcdn.net",
  "threads.com",
  "threads.net",
  "reddit.com",
  "redditstatic.com",
  "redditmedia.com",
  "redd.it",
  "youtube.com",
  "ytimg.com",
  "googlevideo.com",
  "gstatic.com",
  "ggpht.com",
  "tiktok.com",
  "tiktokcdn.com",
  "tiktokcdn-us.com",
  "tiktokv.com",
  "byteoversea.com",
  "ibytedtos.com",
  "ibyteimg.com",
  "ttwstatic.com",
  "x.com",
  "twitter.com",
  "twimg.com",
  "linkedin.com",
  "licdn.com",
  "licdn.cn",
];

export async function readRenderedPublicPostStats(
  input: string,
  wanted: readonly PublicPostMetric[] = [],
) {
  const source = normalizePublicPostUrl(input);
  if (!source || source.short) throw new Error("Unsupported public post identity");
  const id =
    source.platform === "YouTube"
      ? new URL(source.url).searchParams.get("v")!
      : source.platform === "Instagram"
        ? new URL(source.url).pathname.match(/\/(?:p|reels?)\/([^/]+)/)![1]
        : source.platform === "Threads"
          ? new URL(source.url).pathname.match(/\/post\/([^/]+)/)![1]
          : source.platform === "Reddit"
            ? new URL(source.url).pathname.match(/\/comments\/([^/]+)/)![1]
            : discoverPostKey({ sourceUrl: source.url }).split(":").at(-1)!;
  const target = { platform: source.platform, id, wanted: [...wanted] };
  const targetUrl =
    source.platform === "Instagram" ? `https://www.instagram.com/p/${id}/` : source.url;
  const identity = discoverPostKey({ sourceUrl: source.url });
  let phase = "budget";
  let loginGate = false;
  type PageRead = {
    packet: ReturnType<typeof extractPublicPostPage>;
    url: string;
    fallbackValue?: string;
    reelSurface?: string;
  };
  const outcome = await withPublicPostBrowserBudget(async (binding) => {
    const { default: puppeteer } = await import("@cloudflare/puppeteer");
    let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
    let closed = false,
      expired = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let result: PageRead | { error: Error };
    const deadline = Date.now() + 25000;
    try {
      const work = async () => {
        phase = "launch";
        const launched = await puppeteer.launch(binding, { keep_alive: 10000 });
        if (expired) {
          await launched.close();
          throw new Error("Public post browser deadline exceeded");
        }
        browser = launched;
        const page = await browser.newPage();
        await page.setUserAgent(
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
        );
        await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
        await page.setRequestInterception(true);
        page.on("request", async (request) => {
          const url = parsePublicHttpUrl(request.url(), {
            requireHttps: true,
            allowNonStandardPort: false,
          });
          const allowed =
            url && hosts.some((host) => url.hostname === host || url.hostname.endsWith("." + host));
          const navigation = request.isNavigationRequest() && request.frame() === page.mainFrame();
          if (
            navigation &&
            source.platform === "Instagram" &&
            url?.hostname.endsWith("instagram.com") &&
            url.pathname.startsWith("/accounts/login")
          )
            loginGate = true;
          const next = navigation ? normalizePublicPostUrl(request.url()) : null;
          const safeNavigation =
            !navigation ||
            (next?.platform === source.platform &&
              discoverPostKey({ sourceUrl: next.url }) === identity);
          try {
            if (
              !allowed ||
              !safeNavigation ||
              ["image", "media", "font"].includes(request.resourceType()) ||
              (url &&
                (/\.(?:mp4|m4v|webm|m3u8|mpd)$/i.test(url.pathname) ||
                  url.hostname.endsWith(".googlevideo.com")))
            )
              await request.abort();
            else await request.continue();
          } catch {
            /* Request may have ended when the bounded session closes. */
          }
        });
        phase = "navigate";
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 12000 });
        const actual = normalizePublicPostUrl(page.url());
        if (
          !actual ||
          actual.platform !== source.platform ||
          discoverPostKey({ sourceUrl: actual.url }) !== identity
        )
          throw new Error("Public post browser identity changed");
        const capture = async (wantedKeys: string[], limit: number) => {
          const readTarget = { ...target, wanted: wantedKeys };
          const expression = `(()=>{const result=(${extractPublicPostPage.toString()})(${JSON.stringify(readTarget)});return result.ready?result:false;})()`;
          try {
            const handle = await page.waitForFunction(expression, { timeout: limit, polling: 500 });
            const value = (await handle.jsonValue()) as ReturnType<typeof extractPublicPostPage>;
            await handle.dispose();
            return value;
          } catch {
            return page.evaluate(extractPublicPostPage, readTarget);
          }
        };
        phase = "counters";
        const packet = await capture(
          source.platform === "Instagram"
            ? ["likes", "comments", "shares", "reposts"]
            : [...wanted],
          9000,
        );
        const preview: PageRead = { packet, url: page.url(), reelSurface: "not_needed" };
        const previewCounts = publicPostCountEvidence(packet.value, source.url);
        if (
          source.platform === "Instagram" &&
          /\/reels?\//.test(source.url) &&
          wanted.some(
            (key) => ["shares", "reposts"].includes(key) && previewCounts[key] === undefined,
          ) &&
          deadline - Date.now() > 7000
        ) {
          try {
            phase = "reel_surface";
            await page.goto(`https://www.instagram.com/reels/${id}/`, {
              waitUntil: "domcontentloaded",
              timeout: Math.min(5000, deadline - Date.now() - 3000),
            });
            const reelUrl = normalizePublicPostUrl(page.url());
            if (!reelUrl || discoverPostKey({ sourceUrl: reelUrl.url }) !== identity)
              throw new Error("Public Reel identity changed");
            const reelPacket = await capture(
              [...wanted],
              Math.max(1, Math.min(5000, deadline - Date.now() - 1000)),
            );
            return {
              packet: reelPacket,
              url: page.url(),
              fallbackValue: packet.value,
              reelSurface: "loaded",
            };
          } catch {
            return { ...preview, reelSurface: "unavailable" };
          }
        }
        return preview;
      };
      result = await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            expired = true;
            reject(new Error("Public post browser deadline exceeded"));
          }, 25000);
        }),
      ]);
    } catch (error) {
      result = { error: error instanceof Error ? error : new Error("Public post browser failed") };
    } finally {
      if (timeout) clearTimeout(timeout);
      if (browser) {
        let closeTimeout: ReturnType<typeof setTimeout> | undefined;
        try {
          closed = await Promise.race([
            browser.close().then(
              () => true,
              () => false,
            ),
            new Promise<boolean>((resolve) => {
              closeTimeout = setTimeout(() => resolve(false), 3000);
            }),
          ]);
        } finally {
          if (closeTimeout) clearTimeout(closeTimeout);
          if (!closed) void Promise.resolve(browser.disconnect()).catch(() => undefined);
        }
      }
    }
    return { value: result!, browserClosed: closed };
  });
  if ("error" in outcome) {
    console.warn("Direct public post browser unavailable", {
      platform: source.platform,
      phase,
      errorType: outcome.error.name,
    });
    if (loginGate && source.platform === "Instagram")
      return { value: "", counts: {}, precision: {}, requiresSignIn: [...wanted] };
    throw outcome.error;
  }
  const canonical =
    outcome.packet.canonicalUrl && normalizePublicPostUrl(outcome.packet.canonicalUrl);
  if (
    canonical &&
    (canonical.platform !== source.platform ||
      discoverPostKey({ sourceUrl: canonical.url }) !== identity)
  )
    throw new Error("Public post canonical identity changed");
  const counts = {
    ...publicPostCountEvidence(outcome.fallbackValue || "", source.url),
    ...publicPostCountEvidence(outcome.packet.value, source.url),
  };
  const precision: Partial<Record<PublicPostMetric, "rounded" | "unknown">> = {};
  for (const [key, value] of Object.entries(outcome.packet.visibleCounts)) {
    const count = observedCount(value);
    if (count !== null && counts[key as PublicPostMetric] === undefined) {
      counts[key as PublicPostMetric] = count;
      precision[key as PublicPostMetric] = /[kmb]/i.test(value) ? "rounded" : "unknown";
    }
  }
  console.info("Direct public post browser result", {
    platform: source.platform,
    matchedItems: outcome.packet.matchedItems,
    jsonBlocks: outcome.packet.jsonBlocks,
    loginForm: outcome.packet.loginForm,
    metrics: Object.keys(counts),
    loginGate,
    reelSurface: outcome.reelSurface,
  });
  return {
    value: outcome.packet.value,
    counts,
    precision,
    requiresSignIn: loginGate ? wanted.filter((key) => counts[key] === undefined) : [],
  };
}
