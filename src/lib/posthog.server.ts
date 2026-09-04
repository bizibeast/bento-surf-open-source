import { PostHog } from "posthog-node/edge";

type ServerEventProperties = Record<string, string | number | boolean | null | undefined>;

function readEnv(env: unknown, key: string): string | undefined {
  if (env && typeof env === "object") {
    const value = (env as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return process.env[key];
}

function createServerClient(env?: unknown): PostHog | null {
  const key = readEnv(env, "POSTHOG_PROJECT_KEY")?.trim();
  const host = (readEnv(env, "POSTHOG_HOST") ?? "https://us.i.posthog.com").replace(/\/$/, "");
  if (!key) return null;
  return new PostHog(key, { host, requestTimeout: 2_000 });
}

function cleanProperties(properties: ServerEventProperties) {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined));
}

function environmentProperties(env?: unknown): ServerEventProperties {
  return {
    deployment_environment: readEnv(env, "APP_ENV") === "staging" ? "staging" : "production",
  };
}

/** Best-effort server-side lifecycle capture. Analytics can never block billing. */
export async function captureServerEvent(
  distinctId: string,
  event: string,
  properties: ServerEventProperties = {},
  env?: unknown,
): Promise<void> {
  const client = createServerClient(env);
  if (!client) return;

  try {
    await client.captureImmediate({
      distinctId,
      event,
      properties: cleanProperties({ ...properties, ...environmentProperties(env) }),
    });
  } catch (error) {
    console.warn("[posthog] capture failed", error);
  }
}

/** Best-effort Worker exception capture. Error reporting can never alter the response path. */
export async function captureServerException(
  error: unknown,
  distinctId = "bento-worker",
  properties: ServerEventProperties = {},
  env?: unknown,
): Promise<void> {
  const client = createServerClient(env);
  if (!client) return;

  try {
    await client.captureExceptionImmediate(error, distinctId, {
      service: "bento-surf",
      runtime: "cloudflare-worker",
      ...cleanProperties(properties),
      ...environmentProperties(env),
    });
  } catch (captureError) {
    console.warn("[posthog] exception capture failed", captureError);
  }
}
