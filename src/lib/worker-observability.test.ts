import { expect, it } from "vitest";
import { redactWorkerQueryStrings } from "../../scripts/worker-observability";

it("redacts provider query credentials without changing sampling, bindings or other deployment metadata", () => {
  const config = {
    main: "worker.mjs",
    bindings: [{ name: "MEDIA_BUCKET" }],
    observability: {
      enabled: true,
      logs: { head_sampling_rate: 0.1 },
      traces: { enabled: true, head_sampling_rate: 0.01 },
    },
    unsafe: {
      bindings: [{ type: "ratelimit" }],
      metadata: { other: "preserved", observability: { redact_query_string: false } },
    },
  };
  expect(redactWorkerQueryStrings(config)).toEqual({
    ...config,
    unsafe: {
      ...config.unsafe,
      metadata: {
        other: "preserved",
        observability: { ...config.observability, redact_query_string: true },
      },
    },
  });
  expect(config.unsafe.metadata.observability.redact_query_string).toBe(false);
});

it("does not enable observability on instances where it is absent or disabled", () => {
  expect(redactWorkerQueryStrings({ main: "worker.mjs" })).toEqual({ main: "worker.mjs" });
  expect(redactWorkerQueryStrings({ observability: { enabled: false } })).toMatchObject({
    unsafe: { metadata: { observability: { enabled: false, redact_query_string: true } } },
  });
});
