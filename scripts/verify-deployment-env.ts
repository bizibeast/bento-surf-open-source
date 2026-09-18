import { DODO_ADDON_ENV_NAMES, isDodoAddonConfigurationReady } from "../src/lib/billing-addons";

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

function configuredOrigin(name: "VITE_APP_URL" | "VITE_PUBLIC_URL", target: Target) {
  const url = new URL(required(name));
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
  const productionProjectId = required("PRODUCTION_SUPABASE_PROJECT_ID");
  const polarEnvironment = required("POLAR_ENVIRONMENT");
  const paypalEnvironment = required("PAYPAL_ENVIRONMENT");
  required("VITE_SUPABASE_PUBLISHABLE_KEY");
  DODO_ADDON_ENV_NAMES.forEach(required);
  if (!isDodoAddonConfigurationReady(process.env)) {
    throw new Error("Dodo add-on IDs must be unique.");
  }

  if (target === "staging") {
    if (projectId === productionProjectId) {
      throw new Error("Refusing to build staging with the production Supabase project.");
    }
    const configuredProjectId = process.env.VITE_SUPABASE_PROJECT_ID?.trim();
    if (configuredProjectId && configuredProjectId !== projectId) {
      throw new Error("VITE_SUPABASE_PROJECT_ID does not match VITE_SUPABASE_URL.");
    }
    if (process.env.DODO_PAYMENTS_ENVIRONMENT !== "test_mode") {
      throw new Error("A staging build must use Dodo Payments test mode.");
    }
    const commerceProvider = process.env.COMMERCE_PAYMENT_PROVIDER || "mock";
    if (!["disabled", "mock", "stripe", "paypal", "razorpay", "polar"].includes(commerceProvider)) {
      throw new Error("Staging creator commerce has an unknown payment provider.");
    }
    if (polarEnvironment !== "sandbox") {
      throw new Error("Polar must use its sandbox environment in staging.");
    }
    if (paypalEnvironment !== "sandbox") {
      throw new Error("PayPal must use its sandbox environment in staging.");
    }
  }

  if (target === "production") {
    if (projectId !== productionProjectId) {
      throw new Error("A production build must use the production Supabase project.");
    }
    if (process.env.DODO_PAYMENTS_ENVIRONMENT !== "live_mode") {
      throw new Error("A production build must use Dodo Payments live mode.");
    }
    if (process.env.COMMERCE_PAYMENT_PROVIDER === "mock") {
      throw new Error("Mock creator commerce is forbidden in production.");
    }
    if (polarEnvironment !== "production") {
      throw new Error("Polar must use its production environment in production.");
    }
    if (paypalEnvironment !== "production") {
      throw new Error("PayPal must use its production environment in production.");
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
