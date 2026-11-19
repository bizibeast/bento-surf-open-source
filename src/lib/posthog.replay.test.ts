import { beforeEach, describe, expect, it, vi } from "vitest";

const posthogMock = vi.hoisted(() => {
  let flagsCallback: ((...args: unknown[]) => void) | undefined;
  return {
    init: vi.fn(),
    register: vi.fn(),
    capture: vi.fn(),
    onFeatureFlags: vi.fn((cb: (...args: unknown[]) => void) => {
      flagsCallback = cb;
    }),
    fireFlags: () => flagsCallback?.({}, {}, {}),
    getFeatureFlagResult: vi.fn(() => ({ enabled: true })),
    startSessionRecording: vi.fn(),
    stopSessionRecording: vi.fn(),
    set_config: vi.fn(),
    get_property: vi.fn(),
    people: { set: vi.fn(), set_once: vi.fn() },
  };
});

vi.mock("posthog-js", () => ({ default: posthogMock }));

async function load(random: number) {
  vi.resetModules();
  vi.spyOn(Math, "random").mockReturnValue(random);
  return import("./posthog");
}

beforeEach(() => {
  vi.stubEnv("VITE_PUBLIC_POSTHOG_KEY", "phc_test");
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.clearAllMocks();
  posthogMock.getFeatureFlagResult.mockReturnValue({ enabled: true });
});

describe("session replay for checkout sessions", () => {
  it("keeps input masking on and blocks card-like fields", async () => {
    const { setProductSessionRecording, REPLAY_BLOCK_SELECTOR } = await load(0.5);
    setProductSessionRecording(true);
    const config = posthogMock.init.mock.calls[0]?.[1] as {
      disable_session_recording: boolean;
      session_recording: { maskAllInputs: boolean; blockSelector: string };
    };
    expect(config.disable_session_recording).toBe(true);
    expect(config.session_recording.maskAllInputs).toBe(true);
    expect(config.session_recording.blockSelector).toBe(REPLAY_BLOCK_SELECTOR);
    expect(REPLAY_BLOCK_SELECTOR).toContain('input[autocomplete^="cc-"]');
  });

  it("does not record an unsampled session on its own", async () => {
    const { setProductSessionRecording } = await load(0.5); // 0.5 >= 0.1: not sampled
    setProductSessionRecording(true);
    posthogMock.fireFlags();
    expect(posthogMock.startSessionRecording).not.toHaveBeenCalled();
    expect(posthogMock.stopSessionRecording).toHaveBeenCalled();
  });

  it("records an unsampled session once it reaches the trial or checkout step", async () => {
    const { setProductSessionRecording, setCheckoutReplayForced } = await load(0.5);
    setProductSessionRecording(true);
    posthogMock.fireFlags();
    setCheckoutReplayForced();
    expect(posthogMock.startSessionRecording).toHaveBeenCalledWith({ sampling: true });
    expect(window.sessionStorage.getItem("bento:checkout-replay:v1")).toBe("1");
  });

  it("still honors the replay flag and non-replayable routes", async () => {
    posthogMock.getFeatureFlagResult.mockReturnValue({ enabled: false });
    const { setProductSessionRecording, setCheckoutReplayForced } = await load(0.5);
    setProductSessionRecording(true);
    posthogMock.fireFlags();
    setCheckoutReplayForced();
    expect(posthogMock.startSessionRecording).not.toHaveBeenCalled();

    posthogMock.getFeatureFlagResult.mockReturnValue({ enabled: true });
    posthogMock.fireFlags();
    expect(posthogMock.startSessionRecording).toHaveBeenCalledWith({ sampling: true });
    setProductSessionRecording(false);
    expect(posthogMock.stopSessionRecording).toHaveBeenLastCalledWith();
  });

  it("keeps recording after a reload in the same tab", async () => {
    window.sessionStorage.setItem("bento:checkout-replay:v1", "1");
    const { setProductSessionRecording } = await load(0.5);
    setProductSessionRecording(true);
    posthogMock.fireFlags();
    expect(posthogMock.startSessionRecording).toHaveBeenCalledWith({ sampling: true });
  });

  it("sampled sessions keep the normal recording call", async () => {
    const { setProductSessionRecording } = await load(0.05);
    setProductSessionRecording(true);
    posthogMock.fireFlags();
    expect(posthogMock.startSessionRecording).toHaveBeenCalledWith();
  });
});
