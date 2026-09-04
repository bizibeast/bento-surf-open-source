export const SETTINGS_INTEGRATION_TARGETS = [
  "social",
  "bookings",
  "automation",
  "payments",
] as const;

export type SettingsIntegrationTarget = (typeof SETTINGS_INTEGRATION_TARGETS)[number];

export function settingsIntegrationsSearch(integration: SettingsIntegrationTarget) {
  return { section: "integrations" as const, integration };
}

export function settingsIntegrationsPath(integration: SettingsIntegrationTarget) {
  return `/settings?section=integrations&integration=${integration}`;
}

export const INSTAGRAM_CONNECTION_RETURN_TO = {
  social: settingsIntegrationsPath("social"),
  automation: settingsIntegrationsPath("automation"),
  autoDm: "/auto-dms/instagram",
} as const;

export const TWITTER_CONNECTION_RETURN_TO = {
  social: settingsIntegrationsPath("social"),
  automation: settingsIntegrationsPath("automation"),
  autoDm: "/auto-dms/twitter",
} as const;

export const FACEBOOK_CONNECTION_RETURN_TO = {
  social: settingsIntegrationsPath("social"),
  automation: settingsIntegrationsPath("automation"),
  autoDm: "/auto-dms/facebook",
} as const;

export function resolveInstagramConnectionReturn(returnTo: string | null | undefined): {
  to: "/settings" | "/auto-dms/instagram" | "/link";
  search?: ReturnType<typeof settingsIntegrationsSearch>;
  label: string;
} {
  if (returnTo === INSTAGRAM_CONNECTION_RETURN_TO.social) {
    return {
      to: "/settings",
      search: settingsIntegrationsSearch("social"),
      label: "Back to Integrations",
    };
  }
  if (returnTo === INSTAGRAM_CONNECTION_RETURN_TO.automation) {
    return {
      to: "/settings",
      search: settingsIntegrationsSearch("automation"),
      label: "Back to Integrations",
    };
  }
  if (returnTo === INSTAGRAM_CONNECTION_RETURN_TO.autoDm) {
    return {
      to: "/auto-dms/instagram",
      label: "Back to Instagram Auto DMs",
    };
  }
  return { to: "/link", label: "Back to editor" };
}

export function resolveTwitterConnectionReturn(returnTo: string | null | undefined): {
  to: "/settings" | "/auto-dms/twitter" | "/link";
  search?: ReturnType<typeof settingsIntegrationsSearch>;
  label: string;
} {
  if (returnTo === TWITTER_CONNECTION_RETURN_TO.social) {
    return {
      to: "/settings",
      search: settingsIntegrationsSearch("social"),
      label: "Back to Integrations",
    };
  }
  if (returnTo === TWITTER_CONNECTION_RETURN_TO.automation) {
    return {
      to: "/settings",
      search: settingsIntegrationsSearch("automation"),
      label: "Back to Integrations",
    };
  }
  if (returnTo === TWITTER_CONNECTION_RETURN_TO.autoDm) {
    return {
      to: "/auto-dms/twitter",
      label: "Back to X Auto DMs",
    };
  }
  return { to: "/link", label: "Back to editor" };
}

export function resolveFacebookConnectionReturn(returnTo: string | null | undefined): {
  to: "/settings" | "/auto-dms/facebook" | "/link";
  search?: ReturnType<typeof settingsIntegrationsSearch>;
  label: string;
} {
  if (returnTo === FACEBOOK_CONNECTION_RETURN_TO.social) {
    return {
      to: "/settings",
      search: settingsIntegrationsSearch("social"),
      label: "Back to Integrations",
    };
  }
  if (returnTo === FACEBOOK_CONNECTION_RETURN_TO.automation) {
    return {
      to: "/settings",
      search: settingsIntegrationsSearch("automation"),
      label: "Back to Integrations",
    };
  }
  if (returnTo === FACEBOOK_CONNECTION_RETURN_TO.autoDm) {
    return {
      to: "/auto-dms/facebook",
      label: "Back to Facebook Auto DMs",
    };
  }
  return { to: "/link", label: "Back to editor" };
}
