import { useEffect } from "react";
import Featurebase, { hide, shutdown, whenReady } from "featurebase-js";

type FeaturebaseIdentitySyncProps = {
  appId: string | null;
  enableAuthenticatedIdentity?: boolean;
  featurebaseJwt?: string | null;
  theme: "light" | "dark";
};

/**
 * Resolves the Featurebase workspace, boots Messenger, and applies authenticated
 * identity through one SDK instance. Repeated calls for the same app id are
 * handled as identity updates by the SDK.
 */
export function FeaturebaseIdentitySync({
  appId,
  enableAuthenticatedIdentity = false,
  featurebaseJwt,
  theme,
}: FeaturebaseIdentitySyncProps) {
  useEffect(() => {
    if (!appId) return;

    // `undefined` means the authenticated identity query is still loading.
    // Waiting avoids an anonymous boot immediately followed by secure
    // re-identification, which Featurebase correctly warns about when
    // identity verification is enabled.
    if (enableAuthenticatedIdentity && featurebaseJwt === undefined) return;

    // Authenticated identification is a paid Featurebase capability. Keep the
    // reliable anonymous Messenger path as the default so browsers never call
    // `/api/v1/user/identify` unless the workspace explicitly enables it.
    const jwt = enableAuthenticatedIdentity ? featurebaseJwt?.trim() : undefined;
    let cancelled = false;

    try {
      Featurebase({
        appId,
        ...(jwt ? { featurebaseJwt: jwt } : {}),
        hideDefaultLauncher: true,
        language: "en",
        theme,
      });
      // Featurebase persists Messenger's open state between navigations. Close
      // that stale state when the authenticated shell boots so an old support
      // session cannot cover or intercept primary product controls (including
      // the Instagram OAuth button). Users can still open Messenger explicitly
      // from the Bento support launcher.
      whenReady(() => {
        if (!cancelled) hide();
      });
    } catch (error) {
      // Support is an optional third-party surface. A browser extension,
      // blocked script, or stale SDK state must never take down the creator
      // dashboard; the hub keeps its native portal fallback available.
      console.warn("[bento] Featurebase Messenger could not start.", error);
    }

    return () => {
      cancelled = true;
    };
  }, [appId, enableAuthenticatedIdentity, featurebaseJwt, theme]);

  useEffect(() => {
    if (!appId) return;
    return () => {
      try {
        shutdown();
      } catch (error) {
        console.warn("[bento] Featurebase Messenger could not shut down cleanly.", error);
      }
    };
  }, [appId]);

  return null;
}
