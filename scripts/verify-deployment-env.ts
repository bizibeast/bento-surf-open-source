import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseConfigFileTextToJson } from "typescript";

type Target = "production" | "staging";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required ${name} for this deployment.`);
  return value;
}

function supabaseProjectId(value: string) {
  const hostname = new URL(value).hostname.toLowerCase();
  const suffix = ".supabase.co";
  if (!hostname.endsWith(suffix))
    throw new Error("VITE_SUPABASE_URL is not a Supabase project URL.");
  return hostname.slice(0, -suffix.length);
}

function wranglerOrigins() {
  const path = resolve(process.cwd(), "wrangler.jsonc");
  const result = parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
  if (result.error) throw new Error("wrangler.jsonc is not valid JSONC.");
  const vars = (result.config?.vars ?? {}) as Record<string, string>;
  return {
    app: new URL(vars.VITE_APP_URL).origin,
    public: new URL(vars.VITE_PUBLIC_URL).origin,
  };
}

function configuredOrigin(name: "VITE_APP_URL" | "VITE_PUBLIC_URL", target: Target) {
  const value = required(name);
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error(`${name} must be an HTTP(S) origin.`);
  }
  if (target === "production" && url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS in production.`);
  }
  if (url.hostname === "example.com" || url.hostname.endsWith(".example.com")) {
    throw new Error(`${name} still uses the example deployment origin.`);
  }
  return url.origin;
}

function verify(target: Target) {
  const appUrl = configuredOrigin("VITE_APP_URL", target);
  const publicUrl = configuredOrigin("VITE_PUBLIC_URL", target);
  const projectUrl = required("VITE_SUPABASE_URL");
  const projectId = supabaseProjectId(projectUrl);
  const productionProjectId = process.env.PRODUCTION_SUPABASE_PROJECT_ID?.trim();
  required("VITE_SUPABASE_PUBLISHABLE_KEY");
  const configuredProjectId = process.env.VITE_SUPABASE_PROJECT_ID?.trim();
  if (configuredProjectId && configuredProjectId !== projectId) {
    throw new Error("VITE_SUPABASE_PROJECT_ID does not match VITE_SUPABASE_URL.");
  }

  if (target === "staging") {
    if (productionProjectId && projectId === productionProjectId) {
      throw new Error("Refusing to build staging with the production Supabase project.");
    }
    if (process.env.DODO_PAYMENTS_ENVIRONMENT === "live_mode") {
      throw new Error("Staging cannot use Dodo Payments live mode.");
    }
    const commerceProvider = process.env.COMMERCE_PAYMENT_PROVIDER || "mock";
    if (!["disabled", "mock", "stripe", "paypal", "razorpay", "polar"].includes(commerceProvider)) {
      throw new Error("Staging creator commerce has an unknown payment provider.");
    }
    if (process.env.POLAR_ENVIRONMENT === "production") {
      throw new Error("Staging cannot use Polar production mode.");
    }
    if (process.env.PAYPAL_ENVIRONMENT === "production") {
      throw new Error("Staging cannot use PayPal production mode.");
    }
  }

  if (target === "production") {
    const wrangler = wranglerOrigins();
    if (wrangler.app !== appUrl || wrangler.public !== publicUrl) {
      throw new Error("Build-time VITE origins must match wrangler.jsonc.");
    }
    if (productionProjectId && projectId !== productionProjectId) {
      throw new Error("A production build must use the production Supabase project.");
    }
    if (process.env.COMMERCE_PAYMENT_PROVIDER === "mock") {
      throw new Error("Mock creator commerce is forbidden in production.");
    }
  }

  const metaRedirectUri = process.env.META_INSTAGRAM_REDIRECT_URI?.trim();
  if (
    metaRedirectUri &&
    metaRedirectUri !== `${appUrl.replace(/\/$/, "")}/integrations/instagram/callback`
  ) {
    throw new Error("META_INSTAGRAM_REDIRECT_URI must use the application hostname.");
  }

  console.log(`Deployment environment verified for ${target}.`);
}

const target = process.argv[2];
if (target !== "staging" && target !== "production") {
  throw new Error("Usage: bun scripts/verify-deployment-env.ts <staging|production>");
}
verify(target);
