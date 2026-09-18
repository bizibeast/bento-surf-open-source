import { supabaseAdmin } from "@/integrations/supabase/client.server";
export const CREATOR_DOCUMENT_COOKIE = "bento_creator_access";
const PRIVATE = new Set([
  "home",
  "link",
  "settings",
  "admin",
  "store",
  "products",
  "calendar",
  "bookings",
  "community",
  "analytics",
  "onboarding",
  "post-scheduler",
  "earn",
  "auto-dms",
  "social-insights",
  "dashboard",
  "automations",
  "scheduler",
  "priority-dm",
  "email-marketing",
]);
export function isCreatorDocumentPath(pathname: string) {
  return PRIVATE.has(pathname.split("/").filter(Boolean)[0] || "") || pathname.startsWith("/mcp/");
}
export async function guardCreatorDocument(request: Request) {
  const url = new URL(request.url);
  const configuredHost = new URL(process.env.VITE_APP_URL || "http://localhost:8080").hostname;
  if (
    ![configuredHost, "app.example.com", "staging.example.com", "localhost", "127.0.0.1"].includes(
      url.hostname,
    )
  )
    return null;
  if (!["GET", "HEAD"].includes(request.method) || !isCreatorDocumentPath(url.pathname))
    return null;
  const raw = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(CREATOR_DOCUMENT_COOKIE + "="))
    ?.slice(CREATOR_DOCUMENT_COOKIE.length + 1);
  let token = "";
  try {
    token = decodeURIComponent(raw || "");
  } catch {
    /* Invalid cookie behaves like signed out. */
  }
  if (/^[A-Za-z0-9._~-]{20,8192}$/.test(token)) {
    try {
      const result = await supabaseAdmin.auth.getUser(token);
      if (result.data.user && !result.error) return null;
      if (result.error && (result.error.status || 0) >= 500)
        return new Response("Sign-in could not be verified. Please retry.", {
          status: 503,
          headers: { "cache-control": "no-store", "retry-after": "5" },
        });
    } catch {
      return new Response("Sign-in could not be verified. Please retry.", {
        status: 503,
        headers: { "cache-control": "no-store", "retry-after": "5" },
      });
    }
  }
  const login = new URL("/login", url.origin);
  login.searchParams.set("redirect", url.pathname + url.search);
  return new Response(null, {
    status: 302,
    headers: { location: login.toString(), "cache-control": "private, no-store", vary: "Cookie" },
  });
}
