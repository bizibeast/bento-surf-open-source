import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeaturebaseIdentitySync } from "./FeaturebaseIdentitySync";

const { featurebase, hide, shutdown, whenReady } = vi.hoisted(() => ({
  featurebase: vi.fn(),
  hide: vi.fn(),
  shutdown: vi.fn(),
  whenReady: vi.fn((callback: () => void) => callback()),
}));

vi.mock("featurebase-js", () => ({ default: featurebase, hide, shutdown, whenReady }));

describe("FeaturebaseIdentitySync", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not boot Featurebase without an explicitly configured app ID", () => {
    render(<FeaturebaseIdentitySync appId={null} theme="light" />);

    expect(featurebase).not.toHaveBeenCalled();
    expect(whenReady).not.toHaveBeenCalled();
  });

  it("boots Messenger with the signed identity on the core SDK instance", () => {
    render(
      <FeaturebaseIdentitySync
        appId="bento-app"
        enableAuthenticatedIdentity
        featurebaseJwt=" signed-token "
        theme="dark"
      />,
    );

    expect(featurebase).toHaveBeenCalledWith({
      appId: "bento-app",
      featurebaseJwt: "signed-token",
      hideDefaultLauncher: true,
      language: "en",
      theme: "dark",
    });
    expect(whenReady).toHaveBeenCalledOnce();
    expect(hide).toHaveBeenCalledOnce();
  });

  it("waits to boot while a signed identity is loading", () => {
    render(
      <FeaturebaseIdentitySync
        appId="bento-app"
        enableAuthenticatedIdentity
        featurebaseJwt={undefined}
        theme="light"
      />,
    );

    expect(featurebase).not.toHaveBeenCalled();
    expect(whenReady).not.toHaveBeenCalled();
    expect(hide).not.toHaveBeenCalled();
  });

  it("uses anonymous Messenger by default even when a JWT exists", () => {
    render(
      <FeaturebaseIdentitySync appId="bento-app" featurebaseJwt="signed-token" theme="light" />,
    );

    expect(featurebase).toHaveBeenCalledWith({
      appId: "bento-app",
      hideDefaultLauncher: true,
      language: "en",
      theme: "light",
    });
  });

  it("boots anonymously only when the server explicitly has no signed identity", () => {
    render(<FeaturebaseIdentitySync appId="bento-app" featurebaseJwt={null} theme="light" />);

    expect(featurebase).toHaveBeenCalledWith({
      appId: "bento-app",
      hideDefaultLauncher: true,
      language: "en",
      theme: "light",
    });
    expect(whenReady).toHaveBeenCalledOnce();
    expect(hide).toHaveBeenCalledOnce();
  });

  it("does not close Messenger after this identity instance has unmounted", () => {
    let ready: (() => void) | undefined;
    whenReady.mockImplementationOnce((callback: () => void) => {
      ready = callback;
    });

    const view = render(
      <FeaturebaseIdentitySync appId="bento-app" featurebaseJwt="signed-token" theme="light" />,
    );
    view.unmount();
    ready?.();

    expect(hide).not.toHaveBeenCalled();
  });

  it("shuts down Messenger when the authenticated shell unmounts", () => {
    const view = render(
      <FeaturebaseIdentitySync appId="bento-app" featurebaseJwt="signed-token" theme="light" />,
    );
    view.unmount();

    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("does not take down the authenticated shell when the optional SDK is blocked", () => {
    featurebase.mockImplementationOnce(() => {
      throw new Error("blocked by browser");
    });

    expect(() =>
      render(
        <FeaturebaseIdentitySync appId="bento-app" featurebaseJwt="signed-token" theme="light" />,
      ),
    ).not.toThrow();
  });

  it("does not take down the authenticated shell when SDK cleanup fails", () => {
    shutdown.mockImplementationOnce(() => {
      throw new Error("stale SDK");
    });
    const view = render(
      <FeaturebaseIdentitySync appId="bento-app" featurebaseJwt="signed-token" theme="light" />,
    );

    expect(() => view.unmount()).not.toThrow();
  });
});
