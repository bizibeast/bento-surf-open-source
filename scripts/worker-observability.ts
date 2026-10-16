/** Preserve deployment settings while hiding URL query credentials in Cloudflare telemetry. */
export function redactWorkerQueryStrings(config: Record<string, unknown>) {
  const unsafe = (config.unsafe || {}) as Record<string, unknown>;
  const metadata = (unsafe.metadata || {}) as Record<string, unknown>;
  const observability = {
    ...((config.observability || {}) as Record<string, unknown>),
    ...((metadata.observability || {}) as Record<string, unknown>),
  };
  // Do not turn on logging or tracing for an instance that has not enabled it.
  if (!Object.keys(observability).length) return config;
  return {
    ...config,
    unsafe: {
      ...unsafe,
      metadata: {
        ...metadata,
        // The Cloudflare API supports this before Wrangler's config schema does.
        observability: { ...observability, redact_query_string: true },
      },
    },
  };
}
