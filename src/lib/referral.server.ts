import { configuredAppOrigin } from "@/lib/application-urls";
import { normalizeHostname } from "@/lib/custom-domain";
/* eslint-disable @typescript-eslint/no-explicit-any -- Referral tables ship with the paired migration. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { enforceRequestRateLimit } from "./request-security.server";
import { isReferralCode } from "./referrals";

export const REFERRAL_COOKIE = "bento_ref";

export function referralCookieSettings(secure: boolean, configuredDomain?: string | null) {
  const value = configuredDomain?.trim().replace(/^\./, "");
  return {
    path: "/" as const,
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    ...(value ? { domain: normalizeHostname(value) } : {}),
  };
}

function bytesToken(bytes = 32) {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function referralTokenHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function shortText(value: string | null, max = 120) {
  const clean = value?.trim();
  return clean ? clean.slice(0, max) : null;
}

function safeReferrer(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol)
      ? `${url.origin}${url.pathname}`.slice(0, 500)
      : null;
  } catch {
    return null;
  }
}

function userAgentFamily(value: string | null) {
  if (!value) return null;
  for (const name of ["Chrome", "Firefox", "Safari", "Edge", "Instagram", "TikTok"]) {
    if (value.includes(name)) return name;
  }
  return "Other";
}

async function visitorHash(request: Request) {
  const secret = process.env.REFERRAL_HASH_SECRET;
  const ip = request.headers.get("cf-connecting-ip");
  if (!secret || !ip) return null;
  const day = new Date().toISOString().slice(0, 10);
  return referralTokenHash(`${day}:${ip}:${secret}`);
}

export async function handleReferralRedirect(request: Request): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/r\/([^/]+)$/);
  if (!match) return null;
  // This route runs before TanStack creates its request context, so pass the
  // trusted Cloudflare address explicitly instead of asking getRequest().
  await enforceRequestRateLimit(
    "PUBLIC_API_RATE_LIMITER",
    "referral-redirect",
    request.headers.get("cf-connecting-ip")?.trim() || "missing-cloudflare-ip",
  );

  let code: string;
  try {
    code = decodeURIComponent(match[1]);
  } catch {
    code = "";
  }
  const appUrl = configuredAppOrigin(process.env.VITE_APP_URL);
  const destination = new URL("/signup", appUrl);
  for (const key of ["utm_source", "utm_medium", "utm_campaign"] as const) {
    const value = shortText(url.searchParams.get(key));
    if (value) destination.searchParams.set(key, value);
  }

  if (!isReferralCode(code)) {
    return Response.redirect(destination, 302);
  }

  const db = supabaseAdmin as any;
  const [{ data: account, error: accountError }, { data: settings, error: settingsError }] =
    await Promise.all([
      db
        .from("referral_accounts")
        .select("id")
        .eq("code", code)
        .eq("status", "active")
        .maybeSingle(),
      db
        .from("referral_program_settings")
        .select("enabled, attribution_window_days")
        .eq("id", true)
        .maybeSingle(),
    ]);
  if (accountError || settingsError) throw new Error("Referral link could not be loaded.");
  if (!account || !settings?.enabled) return Response.redirect(destination, 302);

  const token = bytesToken();
  const expires = new Date(Date.now() + settings.attribution_window_days * 86_400_000);
  const referrer = safeReferrer(request.headers.get("referer"));
  const { error } = await db.from("referral_clicks").insert({
    account_id: account.id,
    token_hash: await referralTokenHash(token),
    referrer,
    utm_source: shortText(url.searchParams.get("utm_source")),
    utm_medium: shortText(url.searchParams.get("utm_medium")),
    utm_campaign: shortText(url.searchParams.get("utm_campaign")),
    visitor_hash: await visitorHash(request),
    user_agent_family: userAgentFamily(request.headers.get("user-agent")),
    expires_at: expires.toISOString(),
  });
  if (error) throw new Error("Referral click could not be recorded.");

  const production = url.protocol === "https:";
  const cookieSettings = referralCookieSettings(production, process.env.REFERRAL_COOKIE_DOMAIN);
  const cookie = [
    `${REFERRAL_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${settings.attribution_window_days * 86_400}`,
    ...(cookieSettings.secure ? ["Secure"] : []),
    ...(cookieSettings.domain ? [`Domain=${cookieSettings.domain}`] : []),
  ].join("; ");
  return new Response(null, {
    status: 302,
    headers: {
      location: destination.toString(),
      "set-cookie": cookie,
      "cache-control": "no-store",
    },
  });
}
