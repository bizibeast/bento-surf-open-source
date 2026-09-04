export type DeploymentEnvironment = "production" | "staging";

type RuntimeEnvironment = Record<string, unknown> | undefined;

function readString(env: RuntimeEnvironment, key: string) {
  const value = env?.[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  return process.env[key]?.trim();
}

export function getDeploymentEnvironment(env?: RuntimeEnvironment): DeploymentEnvironment {
  return readString(env, "APP_ENV") === "staging" ? "staging" : "production";
}

function supabaseProjectIdFromUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    const suffix = ".supabase.co";
    return hostname.endsWith(suffix) ? hostname.slice(0, -suffix.length) : null;
  } catch {
    return null;
  }
}

export function getStagingIsolationErrors(env?: RuntimeEnvironment) {
  if (getDeploymentEnvironment(env) !== "staging") return [];

  const errors: string[] = [];
  const projectId = readString(env, "SUPABASE_PROJECT_ID");
  const projectIdFromUrl = supabaseProjectIdFromUrl(readString(env, "SUPABASE_URL"));
  const productionProjectId = readString(env, "PRODUCTION_SUPABASE_PROJECT_ID");

  if (!projectId || !projectIdFromUrl) {
    errors.push("A separate staging Supabase project is not configured.");
  } else if (projectId !== projectIdFromUrl) {
    errors.push("The staging Supabase project ID does not match its URL.");
  }

  if (
    productionProjectId &&
    (projectId === productionProjectId || projectIdFromUrl === productionProjectId)
  ) {
    errors.push("The staging Worker is pointing at the production Supabase project.");
  }

  if (readString(env, "DODO_PAYMENTS_ENVIRONMENT") !== "test_mode") {
    errors.push("The staging Worker must use Dodo Payments test mode.");
  }

  if (readString(env, "CUSTOM_DOMAINS_ENABLED") !== "false") {
    errors.push("Custom-domain mutations must be disabled in staging.");
  }

  if (!env?.MEDIA_BUCKET) {
    errors.push("The staging R2 bucket is not bound.");
  }

  if (!env?.ANALYTICS_QUEUE) {
    errors.push("The staging analytics queue is not bound.");
  }

  return errors;
}

export function stagingResponseHeaders(env?: RuntimeEnvironment) {
  if (getDeploymentEnvironment(env) !== "staging") return {};
  return {
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow, noarchive",
  };
}
