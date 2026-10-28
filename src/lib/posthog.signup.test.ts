import { beforeEach, describe, expect, it, vi } from "vitest";

const posthogMock = vi.hoisted(() => {
  const props: Record<string, unknown> = {};
  return {
    props,
    init: vi.fn(),
    register: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
    capture: vi.fn(),
    captureException: vi.fn(),
    onFeatureFlags: vi.fn(),
    getFeatureFlagResult: vi.fn(),
    startSessionRecording: vi.fn(),
    stopSessionRecording: vi.fn(),
    set_config: vi.fn(),
    get_property: vi.fn((key: string) => props[key]),
    people: { set: vi.fn(), set_once: vi.fn() },
  };
});

vi.mock("posthog-js", () => ({ default: posthogMock }));

async function loadPostHog() {
  vi.resetModules();
  return import("./posthog");
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

describe("signup analytics", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_PUBLIC_POSTHOG_KEY", "phc_test");
    window.localStorage.clear();
    vi.clearAllMocks();
    for (const key of Object.keys(posthogMock.props)) delete posthogMock.props[key];
    posthogMock.props.$initial_person_info = {
      r: "https://www.linkedin.com/feed/",
      u: "https://bento.surf/?utm_source=test&utm_medium=link&utm_campaign=funnel",
    };
  });

  function signupCalls() {
    return posthogMock.capture.mock.calls.filter(([event]) => event === "signup_completed");
  }

  it("captures one signup_completed for a fresh Google account with first touch", async () => {
    const { captureProductPageview, identifyProductUser } = await loadPostHog();
    captureProductPageview("/onboarding");
    const user = {
      id: "user-google",
      email: "owner+google@qa.example.test",
      createdAt: minutesAgo(1),
      provider: "google",
    };
    identifyProductUser(user);
    identifyProductUser(user);

    expect(posthogMock.identify).toHaveBeenCalledWith("user-google");
    expect(signupCalls()).toHaveLength(1);
    const [, properties, options] = signupCalls()[0];
    expect(properties).toMatchObject({
      method: "google",
      first_utm_source: "test",
      first_utm_medium: "link",
      first_utm_campaign: "funnel",
      first_referrer: "linkedin.com",
      first_landing_path: "/",
      first_channel: "test",
    });
    expect(options).toEqual({
      $set_once: {
        first_utm_source: "test",
        first_utm_medium: "link",
        first_utm_campaign: "funnel",
        first_referrer: "linkedin.com",
        first_landing_path: "/",
        first_channel: "test",
      },
    });
    expect(posthogMock.register).toHaveBeenCalledWith({ is_test_account: true });
    expect(posthogMock.people.set).toHaveBeenCalledWith({
      is_test_account: true,
      $internal_or_test_user: true,
    });
    expect(JSON.stringify(posthogMock.capture.mock.calls)).not.toContain("@");
    expect(JSON.stringify(posthogMock.people.set.mock.calls)).not.toContain("@");
  });

  it("does not capture a signup on a later reload after the first capture", async () => {
    const user = { id: "user-repeat", createdAt: minutesAgo(1), provider: "google" };
    let module = await loadPostHog();
    module.captureProductPageview("/onboarding");
    module.identifyProductUser(user);
    module = await loadPostHog();
    module.captureProductPageview("/onboarding");
    module.identifyProductUser(user);
    expect(signupCalls()).toHaveLength(1);
  });

  it("ignores returning Google logins and email-provider sessions", async () => {
    const { captureProductPageview, identifyProductUser } = await loadPostHog();
    captureProductPageview("/onboarding");
    identifyProductUser({ id: "old", createdAt: minutesAgo(60 * 24), provider: "google" });
    identifyProductUser({ id: "mail", createdAt: minutesAgo(1), provider: "email" });
    expect(signupCalls()).toHaveLength(0);
  });

  it("applies an identity that arrived before the SDK started", async () => {
    const { captureProductPageview, identifyProductUser } = await loadPostHog();
    identifyProductUser({ id: "early", createdAt: minutesAgo(1), provider: "google" });
    expect(posthogMock.identify).not.toHaveBeenCalled();
    captureProductPageview("/onboarding");
    expect(posthogMock.identify).toHaveBeenCalledWith("early");
    expect(signupCalls()).toHaveLength(1);
  });

  it("identifies an email signup and flags test traffic without sending the email", async () => {
    const { captureSignupCompleted } = await loadPostHog();
    captureSignupCompleted({
      method: "email",
      email: "stgfix-7@example.com",
      userId: "user-email",
      properties: { confirmation_required: true },
    });
    expect(posthogMock.identify).toHaveBeenCalledWith("user-email");
    expect(posthogMock.register).toHaveBeenCalledWith({ is_test_account: true });
    expect(signupCalls()).toHaveLength(1);
    expect(signupCalls()[0][1]).toMatchObject({
      method: "email",
      confirmation_required: true,
      first_utm_source: "test",
    });
    expect(JSON.stringify(posthogMock.capture.mock.calls)).not.toContain("@");
  });

  it("does not flag real customers", async () => {
    const { captureSignupCompleted } = await loadPostHog();
    captureSignupCompleted({ method: "email", email: "creator@gmail.com", userId: "real" });
    expect(posthogMock.register).not.toHaveBeenCalledWith({ is_test_account: true });
    expect(posthogMock.people.set).not.toHaveBeenCalled();
  });
});
