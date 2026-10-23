import { afterEach, describe, expect, it, vi } from "vitest";

const { captureExceptionImmediate } = vi.hoisted(() => ({
  captureExceptionImmediate: vi.fn(),
}));

vi.mock("posthog-node/edge", () => ({
  PostHog: vi.fn(function PostHogMock(this: {
    captureExceptionImmediate: typeof captureExceptionImmediate;
  }) {
    this.captureExceptionImmediate = captureExceptionImmediate;
  }),
}));

vi.mock("./provider-budget.server", () => ({
  reserveProviderUsage: vi.fn(async () => undefined),
}));

import { captureServerException } from "./posthog.server";

afterEach(() => {
  captureExceptionImmediate.mockReset();
  vi.unstubAllEnvs();
  Reflect.deleteProperty(globalThis, "__env__");
});

describe("server exception environment", () => {
  it("tags exceptions from the hydrated runtime when the caller omits env", async () => {
    vi.stubEnv("POSTHOG_PROJECT_KEY", "phc_test");
    vi.stubGlobal("__env__", { APP_ENV: "staging" });

    await captureServerException(new Error("boom"));

    expect(captureExceptionImmediate).toHaveBeenCalledWith(
      expect.any(Error),
      "bento-worker",
      expect.objectContaining({ deployment_environment: "staging" }),
    );
  });

  it("tags production exceptions when APP_ENV is production", async () => {
    await captureServerException(
      new Error("boom"),
      "bento-worker",
      { surface: "worker_fetch" },
      {
        APP_ENV: "production",
        POSTHOG_PROJECT_KEY: "phc_test",
      },
    );

    expect(captureExceptionImmediate).toHaveBeenCalledWith(
      expect.any(Error),
      "bento-worker",
      expect.objectContaining({
        deployment_environment: "production",
        surface: "worker_fetch",
      }),
    );
  });
});
