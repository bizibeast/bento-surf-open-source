import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { billingAllows } from "./billing-lifecycle";
import { getPlan, isSelfHostedEdition } from "./plan.server";
import { resolvePublicUsername } from "./username-alias.server";

const reserved = new Set([
  "api",
  "_server",
  "assets",
  "login",
  "signup",
  "settings",
  "onboarding",
  "dashboard",
  "link",
  "calendar",
  "products",
  "store",
  "community",
  "post-scheduler",
  "auto-dms",
  "automations",
  "analytics",
  "social-insights",
  "brain",
  "agent",
  "discover",
  "email-marketing",
  "newsletter",
  "integrations",
  "admin",
  "access",
  "library",
  "mcp",
  "pricing",
  "features",
  "compare",
  "help",
  "blog",
  "privacy",
  "terms",
  "data-deletion",
  "tools",
  "about",
  "open-source",
]);

export async function isWorkspacePublicBillingAvailable(workspaceId: string) {
  if (isSelfHostedEdition()) return true;
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("billing_lifecycle")
    .eq("id", workspaceId)
    .maybeSingle();
  if (error) throw new Error("Page availability could not be checked.");
  if (!data) return false;
  return (
    billingAllows(data.billing_lifecycle, "public") ||
    (await getPlan(workspaceId, "public")) !== "free"
  );
}

export function unavailableWorkspaceResponse(appUrl = "http://localhost:8080") {
  const login = new URL("/settings?section=plan", appUrl)
    .toString()
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Page temporarily unavailable · Bento</title><style>
  @font-face{font-family:Inter;src:url('/fonts/inter-latin.woff2') format('woff2');font-display:swap}@font-face{font-family:Instrument;src:url('/fonts/instrument-serif-latin.woff2') format('woff2');font-display:swap}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f8f7f4;color:#232323;font-family:Inter,system-ui,sans-serif;padding:24px}main{max-width:520px;text-align:center;background:#fff;border:1px solid #e9e7e2;border-radius:28px;padding:48px 32px;box-shadow:0 24px 70px -48px #333;animation:arrive .5s ease both}.mark{display:block;width:48px;height:48px;margin:0 auto 24px}h1{font:400 clamp(32px,6vw,44px)/1.08 Instrument,Georgia,serif;letter-spacing:-.04em;margin:0 0 20px}p{color:#68655f;font-size:15px;line-height:1.65;margin:0 0 28px}a{display:inline-block;border-radius:14px;padding:14px 24px;background:#232323;color:#fff;text-decoration:none;font-size:14px;font-weight:600;transition:transform .2s}a:hover{transform:translateY(-2px)}a:focus-visible{outline:3px solid #3478f6;outline-offset:4px}.brand{font-size:12px;color:#888;margin:28px 0 0}@keyframes arrive{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){main{animation:none}a{transition:none}}
  </style></head><body><main><img class="mark" src="/branding/bento-logo.svg" width="48" height="48" alt="Bento"><h1>This page is temporarily unavailable.</h1><p>If you own this page, sign in to manage your workspace and bring it back.</p><a href="${login}">Sign in to manage your page</a><p class="brand">Made with Bento</p></main></body></html>`,
    {
      status: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": "86400",
        "x-robots-tag": "noindex",
      },
    },
  );
}

/** Runs before HTML caches, including signed-in visitors and nested product URLs. */
export async function guardUnavailablePublicWorkspace(request: Request) {
  if (isSelfHostedEdition() || !["GET", "HEAD"].includes(request.method)) return null;
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.some((part) => part.startsWith("_") || part.includes("."))) return null;
  const first = segments[0]?.toLowerCase();
  const appHost = /(^|\.)(bento\.surf|localhost|workers\.dev|pages\.dev)$/.test(url.hostname);
  if (first && ((appHost && reserved.has(first)) || ["api", "assets", "_server"].includes(first)))
    return null;
  const accept = request.headers.get("accept") || "";
  if (accept && !accept.includes("text/html") && !accept.includes("*/*")) return null;
  let workspaceId: string | undefined;
  if (!appHost) {
    const { data, error } = await supabaseAdmin
      .from("custom_domains")
      .select("user_id")
      .eq("hostname", url.hostname)
      .eq("status", "active")
      .eq("ssl_status", "active")
      .maybeSingle();
    if (error) throw new Error("Page availability could not be checked.");
    workspaceId = data?.user_id;
  } else if (first === "p" && segments[1]) {
    const { data, error } = await supabaseAdmin
      .from("commerce_products")
      .select("creator_id")
      .eq("slug", segments[1])
      .maybeSingle();
    if (error) throw new Error("Page availability could not be checked.");
    workspaceId = data?.creator_id;
  } else if (first) {
    workspaceId = (
      await resolvePublicUsername(supabaseAdmin, decodeURIComponent(first).replace(/^@/, ""))
    )?.userId;
  }
  if (!workspaceId) return null;
  if (await isWorkspacePublicBillingAvailable(workspaceId)) return null;
  return unavailableWorkspaceResponse(process.env.VITE_APP_URL);
}
